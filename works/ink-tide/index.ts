import { Vector2 } from 'three';
import { shaderPrelude, stdUniforms, updateStdUniforms } from '../../src/engine/glsl';
import { CopyPass, createTarget, FullscreenPass, PingPong } from '../../src/engine/passes';
import { defineInstrument } from '../../src/engine/types';
import type { InstrumentManifest } from '../../src/engine/types';
import {
  captureHistory, HISTORY_FRAMES, PRESSURE_ITERATIONS, historyPair, initialDance, initialHistory, simulationSize, simulationSteps, stepDance,
} from './choreography';
import advectFragment from './advect.frag?raw';
import divergenceFragment from './divergence.frag?raw';
import jacobiFragment from './jacobi.frag?raw';
import projectFragment from './project.frag?raw';
import dyeFragment from './dye.frag?raw';
import fluidCommon from './fluid.glsl?raw';
import domain from './domain.glsl?raw';
import replayFragment from './replay.frag?raw';
import normalFragment from './normal.frag?raw';
import inkFragment from './ink.frag?raw';
import seedFragment from './seed.frag?raw';
import shape from './shape.glsl?raw';

const manifest: InstrumentManifest = {
  id: 'ink-tide', name: 'INK TIDE', nameJa: '墨潮',
  mood: ['calm', 'deep', 'organic'], energy: [0.1, 0.8], tempo: 'both',
  macros: [
    { id: 'energy', label: 'Energy', default: 0.32, mod: { source: 'low', amount: 0.22 } },
    { id: 'viscosity', label: 'Viscosity', default: 0.72 },
    { id: 'gloss', label: 'Gloss', default: 0.65 },
    { id: 'stretch', label: 'Stretch', default: 0.68 },
    { id: 'tension_gain', label: 'Tension', default: 0.65 },
    { id: 'warmth', label: 'Warmth', default: 0.22 },
    { id: 'calm', label: 'Calm', default: 0.95 },
    { id: 'reverse', label: 'Reverse', default: 1 },
  ],
  presets: {
    calm: { energy: 0.18, viscosity: 0.9, gloss: 0.58, stretch: 0.42, tension_gain: 0.6, warmth: 0.16, calm: 1, reverse: 1 },
    surge: { energy: 0.58, viscosity: 0.48, gloss: 0.8, stretch: 0.95, tension_gain: 0.85, warmth: 0.3, calm: 0.9, reverse: 1 },
  },
};

export default defineInstrument({
  manifest,
  create({ renderer, width, height }) {
    const velocity = new PingPong(1, 1);
    const dye = new PingPong(1, 1);
    const pressure = new PingPong(1, 1);
    const divergence = createTarget(1, 1);
    const seedInk = createTarget(1, 1);
    const replayInk = createTarget(1, 1);
    const surface = createTarget(1, 1);
    const snapshots = Array.from({ length: HISTORY_FRAMES }, () => createTarget(1, 1));
    const texel = new Vector2(1, 1);
    const aspect = { value: 1 };
    const fluidStd = stdUniforms();
    const grid = { uTexel: { value: texel }, uAspect: aspect };
    const dtU = { value: 0 }, gatherU = { value: 0 }, burstU = { value: 0 }, floodU = { value: 0 };
    const bloomU = { value: 0 };
    const advectU = {
      ...fluidStd, ...grid, uVelocity: { value: velocity.read.texture }, uDye: { value: dye.read.texture },
      uDt: dtU, uStroke: { value: 0 }, uArc: { value: 0 }, uGather: gatherU,
      uSlowLow: { value: 0 }, uBurst: burstU,
    };
    const divergenceU = { ...grid, uVelocity: { value: velocity.read.texture } };
    const jacobiU = { ...grid, uPressure: { value: pressure.read.texture }, uDivergence: { value: divergence.texture } };
    const projectU = { ...grid, uVelocity: { value: velocity.read.texture }, uPressure: { value: pressure.read.texture } };
    const dyeU = {
      ...fluidStd, ...grid, uVelocity: { value: velocity.read.texture }, uDye: { value: dye.read.texture },
      uSeed: { value: seedInk.texture }, uDt: dtU, uGather: gatherU, uBurst: burstU, uFlood: floodU, uBloom: bloomU,
    };
    const replayU = {
      ...grid, uDye: { value: dye.read.texture },
      uHistoryA: { value: snapshots[0].texture }, uHistoryB: { value: snapshots[0].texture },
      uHistoryMix: { value: 0 }, uReplay: { value: -1 }, uCollapse: { value: 0 },
    };
    const normalU = { uTexel: grid.uTexel, uDye: { value: dye.read.texture } };
    const inkU = {
      ...stdUniforms(), uAspect: aspect, uDye: { value: dye.read.texture },
      uSurface: { value: surface.texture }, uFlood: floodU,
    };
    const seedU = { uAspect: aspect, uTexel: grid.uTexel, uSeedKind: { value: 0 } };
    const prelude = shaderPrelude(manifest);
    const fluid = domain + fluidCommon;
    const shapes = domain + shape;
    const advect = new FullscreenPass({ fragmentShader: prelude + fluid + advectFragment, uniforms: advectU });
    const divergencePass = new FullscreenPass({ fragmentShader: fluid + divergenceFragment, uniforms: divergenceU });
    const jacobi = new FullscreenPass({ fragmentShader: fluid + jacobiFragment, uniforms: jacobiU });
    const project = new FullscreenPass({ fragmentShader: fluid + projectFragment, uniforms: projectU });
    const dyePass = new FullscreenPass({ fragmentShader: prelude + fluid + dyeFragment, uniforms: dyeU });
    const replay = new FullscreenPass({ fragmentShader: shapes + replayFragment, uniforms: replayU });
    const normal = new FullscreenPass({ fragmentShader: normalFragment, uniforms: normalU });
    const ink = new FullscreenPass({ fragmentShader: prelude + shapes + inkFragment, uniforms: inkU });
    const seed = new FullscreenPass({ fragmentShader: shapes + seedFragment, uniforms: seedU });
    const copy = new CopyPass();
    let danceState = initialDance();
    let history = initialHistory();
    let initialized = false;
    let outputWidth = 0, outputHeight = 0;
    let lastTime = -Infinity, lastFrame = -1, lastBeats = -Infinity;

    function resize(w: number, h: number) {
      outputWidth = Math.max(1, Math.floor(w));
      outputHeight = Math.max(1, Math.floor(h));
      const [fw, fh] = simulationSize(w, h);
      velocity.resize(fw, fh);
      dye.resize(fw, fh);
      pressure.resize(fw, fh);
      for (const target of [divergence, seedInk, replayInk, surface]) target.setSize(fw, fh);
      for (const target of snapshots) target.setSize(fw, fh);
      texel.set(1 / fw, 1 / fh);
      aspect.value = fw / fh;
      initialized = false;
      history = initialHistory();
      danceState = initialDance();
      lastTime = -Infinity;
      lastFrame = -1;
      lastBeats = -Infinity;
    }

    function initialize(drop = false) {
      seedU.uSeedKind.value = 0;
      for (const target of [velocity.read, velocity.write, pressure.read, pressure.write, divergence]) seed.render(renderer, target);
      if (!drop) {
        seedU.uSeedKind.value = 1;
        seed.render(renderer, seedInk);
      }
      seedU.uSeedKind.value = drop ? 2 : 1;
      seed.render(renderer, dye.read);
      seed.render(renderer, dye.write);
      initialized = true;
    }

    function capture(force = false) {
      const result = captureHistory(force ? { ...history, nextBeat: 0 } : history, danceState.elapsed);
      history = result.state;
      if (result.slot !== null) copy.render(renderer, dye.read.texture, snapshots[result.slot]);
    }

    function simulate(dt: number) {
      dtU.value = dt;
      advectU.uVelocity.value = velocity.read.texture;
      advectU.uDye.value = dye.read.texture;
      advect.render(renderer, velocity.write);
      velocity.swap();
      divergenceU.uVelocity.value = velocity.read.texture;
      divergencePass.render(renderer, divergence);
      for (let i = 0; i < PRESSURE_ITERATIONS; i++) {
        jacobiU.uPressure.value = pressure.read.texture;
        jacobi.render(renderer, pressure.write);
        pressure.swap();
      }
      projectU.uVelocity.value = velocity.read.texture;
      projectU.uPressure.value = pressure.read.texture;
      project.render(renderer, velocity.write);
      velocity.swap();
      dyeU.uVelocity.value = velocity.read.texture;
      dyeU.uDye.value = dye.read.texture;
      dyePass.render(renderer, dye.write);
      dye.swap();
    }

    resize(width, height);
    return {
      render(frame, target) {
        if (frame.width !== outputWidth || frame.height !== outputHeight) resize(frame.width, frame.height);
        if (frame.signals.time < lastTime) {
          initialized = false;
          history = initialHistory();
          danceState = initialDance();
          lastTime = -Infinity;
          lastFrame = -1;
          lastBeats = -Infinity;
        }
        if (!initialized) {
          initialize();
          capture(true);
        }
        // The load-time trial has dt=0; a new frame can share its timestamp.
        const duplicate = frame.signals.time === lastTime && frame.signals.frame === lastFrame
          && frame.signals.beats === lastBeats;
        const dt = duplicate ? 0 : Math.max(0, Math.min(0.1, frame.signals.dt));
        if (frame.signals.dt > 0) {
          lastTime = frame.signals.time;
          lastFrame = frame.signals.frame;
          lastBeats = frame.signals.beats;
        }
        updateStdUniforms(fluidStd, frame);
        updateStdUniforms(inkU, frame);
        const dance = stepDance(danceState, frame.signals, dt, frame.macros[4] ?? 0.65);
        danceState = dance.state;
        if (dance.dropStarted) capture(true);
        if (dance.burstStarted) {
          initialize(true);
          history = initialHistory();
        }
        advectU.uStroke.value = dance.stroke;
        advectU.uArc.value = danceState.arc;
        gatherU.value = dance.gather;
        advectU.uSlowLow.value = dance.low;
        burstU.value = dance.burst;
        floodU.value = dance.flood;
        bloomU.value = dance.bloom;
        if (dance.replay < 0 && dt > 0) {
          const simulationDt = Math.min(0.05, dt);
          const steps = simulationSteps(simulationDt);
          for (let i = 0; i < steps; i++) simulate(simulationDt / steps);
          capture();
        }
        const pair = historyPair(history, Math.max(0, dance.replay) * (frame.macros[7] ?? 1));
        replayU.uHistoryA.value = snapshots[pair.a].texture;
        replayU.uHistoryB.value = snapshots[pair.b].texture;
        replayU.uHistoryMix.value = pair.mix;
        replayU.uReplay.value = dance.replay;
        replayU.uCollapse.value = dance.collapse;
        replayU.uDye.value = dye.read.texture;
        if (dance.replay >= 0) replay.render(renderer, replayInk);
        const visibleInk = dance.replay >= 0 ? replayInk.texture : dye.read.texture;
        normalU.uDye.value = visibleInk;
        normal.render(renderer, surface);
        inkU.uDye.value = visibleInk;
        ink.render(renderer, target);
      },
      resize,
      dispose() {
        for (const pass of [advect, divergencePass, jacobi, project, dyePass, replay, normal, ink, seed, copy]) pass.dispose();
        velocity.dispose(); dye.dispose(); pressure.dispose();
        for (const target of [divergence, seedInk, replayInk, surface]) target.dispose();
        for (const target of snapshots) target.dispose();
      },
    };
  },
});
