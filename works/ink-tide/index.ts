import { Vector2 } from 'three';
import { shaderPrelude, stdUniforms, updateStdUniforms } from '../../src/engine/glsl';
import { createTarget, FullscreenPass } from '../../src/engine/passes';
import { defineInstrument } from '../../src/engine/types';
import type { InstrumentManifest } from '../../src/engine/types';
import flowFragment from './flow.frag?raw';
import inkFragment from './ink.frag?raw';

const manifest: InstrumentManifest = {
  id: 'ink-tide',
  name: 'INK TIDE',
  nameJa: '墨潮',
  mood: ['calm', 'deep', 'organic'],
  energy: [0.1, 0.65],
  tempo: 'both',
  macros: [
    { id: 'energy', label: 'Energy', default: 0.32, mod: { source: 'low', amount: 0.3 } },
    { id: 'flow', label: 'Flow', default: 0.28 },
    { id: 'density', label: 'Density', default: 0.52 },
    { id: 'detail', label: 'Detail', default: 0.78 },
    { id: 'trails', label: 'Trails', default: 0.68 },
    { id: 'warmth', label: 'Warmth', default: 0.22 },
    { id: 'swirl', label: 'Swirl', default: 0.62 },
    { id: 'calm', label: 'Calm', default: 0.9 },
  ],
  presets: {
    calm: { energy: 0.2, flow: 0.16, density: 0.4, detail: 0.86, trails: 0.8, warmth: 0.16, swirl: 0.52, calm: 1 },
    surge: { energy: 0.57, flow: 0.44, density: 0.7, detail: 0.8, trails: 0.72, warmth: 0.32, swirl: 0.78, calm: 0.82 },
  },
};

export default defineInstrument({
  manifest,
  create({ renderer, width, height }) {
    const field = createTarget(1, 1);
    const flowUniforms = stdUniforms();
    const inkUniforms = {
      ...stdUniforms(),
      uField: { value: field.texture },
      uFieldSize: { value: new Vector2(1, 1) },
    };
    const flowPass = new FullscreenPass({
      fragmentShader: shaderPrelude(manifest) + flowFragment,
      uniforms: flowUniforms,
    });
    const inkPass = new FullscreenPass({
      fragmentShader: shaderPrelude(manifest) + inkFragment,
      uniforms: inkUniforms,
    });
    let outputWidth = 0;
    let outputHeight = 0;

    function resize(w: number, h: number) {
      outputWidth = Math.max(1, Math.floor(w));
      outputHeight = Math.max(1, Math.floor(h));
      const scale = Math.min(0.5, 960 / outputWidth, 540 / outputHeight);
      const fw = Math.max(1, Math.ceil(outputWidth * scale));
      const fh = Math.max(1, Math.ceil(outputHeight * scale));
      field.setSize(fw, fh);
      inkUniforms.uFieldSize.value.set(fw, fh);
    }

    resize(width, height);
    return {
      render(frame, target) {
        if (frame.width !== outputWidth || frame.height !== outputHeight) resize(frame.width, frame.height);
        updateStdUniforms(flowUniforms, frame);
        updateStdUniforms(inkUniforms, frame);
        // Absolute-time advection keeps independent windows and repeated frames identical.
        flowPass.render(renderer, field);
        inkPass.render(renderer, target);
      },
      resize,
      dispose() {
        flowPass.dispose();
        inkPass.dispose();
        field.dispose();
      },
    };
  },
});
