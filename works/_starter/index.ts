// STARTER — the plumbing of a Studio-built WebGPU world. The Studio build copies this file to works/<id>/index.ts next
// to the approved key visual and motion studies; the agent then replaces the placeholder world (the key visual as a
// luminance relief, lit by random bands on kicks) with the real one. Keep the plumbing: signals → director → camera →
// post → the deck's target, light as events, everything released in dispose(). Folders starting with `_` are not
// listed, so this file never plays by itself.
import { DoubleSide, Mesh, MeshBasicNodeMaterial, PerspectiveCamera, PlaneGeometry, Scene, Vector3 } from 'three/webgpu';
import type { RenderTarget } from 'three/webgpu';
import { abs, float, positionLocal, smoothstep, texture, uniform, uv, vec2, vec3, vec4 } from 'three/tsl';
import { defineGpuInstrument } from '../../src/engine/gpu/types';
import type { InstrumentManifest } from '../../src/engine/types';
import { Director } from '../../src/engine/gpu/world/director';
import { dollyFov, ease, makePost, shake } from '../../src/engine/gpu/world/kit';
import { coverUv, keyImage } from '../../src/engine/gpu/image';
import kv from './keyvisual.jpg';

const manifest: InstrumentManifest = {
  id: 'starter', // the build replaces this with the work id (= folder name)
  name: 'STARTER',
  nameJa: '雛形',
  mood: ['placeholder'],
  energy: [0.2, 0.9],
  tempo: 'sync',
  macros: [
    { id: 'depth', label: 'Depth', default: 0.4, mod: { source: 'tension', amount: 0.3 } },
    { id: 'hits', label: 'Hits', default: 0.6, mod: { source: 'low', amount: 0.2 } },
    { id: 'glow', label: 'Glow', default: 0.4 },
    { id: 'trails', label: 'Trails', default: 0.2 },
    { id: 'cut', label: 'Cut rate', default: 0.5 },
  ],
  presets: { calm: { depth: 0.2, hits: 0.3, glow: 0.3, trails: 0.4, cut: 0.2 } },
};

// Plane in world units, 16:9 like the key visual.
const W = 16;
const H = 9;

export default defineGpuInstrument({
  manifest,
  create({ renderer, width, height }) {
    const scene = new Scene();
    const camera = new PerspectiveCamera(40, width / height, 0.05, 200);
    const director = new Director({ shots: 5, styles: 3, impactShot: 3, buildShot: 4, calmShots: [0, 2], impactStyles: [1, 2], seed: 5 });
    const post = makePost(renderer, scene, camera);

    // ---- uniforms the CPU drives (events, not states)
    const depth = uniform(0.4);
    const bandY = uniform(0.5); // where the last kick lit the image (0..1)
    const band = uniform(0); // that light, decaying
    const flood = uniform(0); // the drop lights everything at once

    // ---- the placeholder world: the key visual as a relief, dim until an event lights it
    const key = keyImage(kv);
    const p = coverUv(uv(), vec2(W, H), key.size);
    const lum = texture(key.tex, p, float(0)).rgb.dot(vec3(0.2126, 0.7152, 0.0722)); // level 0: vertex stage
    const material = new MeshBasicNodeMaterial({ side: DoubleSide });
    material.positionNode = positionLocal.add(vec3(0, 0, lum.mul(depth).mul(2.5)));
    const lit = smoothstep(0.12, 0, abs(uv().y.sub(bandY))).mul(band).add(flood);
    material.colorNode = vec4(texture(key.tex, p).rgb.mul(float(0.25).add(lit.mul(2.5))), 1);
    const geometry = new PlaneGeometry(W, H, 320, 180);
    scene.add(new Mesh(geometry, material));

    let seed = 1;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    let lastKickAge = 99;
    let dropAt = -99;
    let lastFlash = false;
    const at = new Vector3();

    /** Shots: 0 wide front, 1 low oblique, 2 close drift, 3 impact pull-back, 4 build dolly zoom. */
    function frameShot(shot: number, l: number, kick: number, level: number) {
      let fov = 40;
      at.set(0, 0, 0);
      if (shot === 0) camera.position.set(Math.sin(l * 0.05) * 2, 0.3, 17);
      else if (shot === 1) camera.position.set(-7 + l * 0.15, -4.5, 7);
      else if (shot === 2) {
        camera.position.set(2.5 + l * 0.06, 1, 4.5);
        at.set(2.5 + l * 0.06, 1, 0);
      } else if (shot === 3) {
        camera.position.set(0, 0, 9 + ease.out(l / 4) * 12);
        fov = 55;
      } else {
        const d = 22 - ease.inOut(l / 16) * 16;
        camera.position.set(0, 0, d);
        fov = Math.min(100, dollyFov(H * 0.9, d));
      }
      const [sx, sy, sz] = shake(l, 0.01 + 0.08 * kick * level);
      camera.position.x += sx;
      camera.position.y += sy;
      camera.position.z += sz;
      camera.fov = fov;
      camera.updateProjectionMatrix();
      camera.lookAt(at);
    }

    return {
      render(frame, target: RenderTarget) {
        const s = frame.signals;
        const m = frame.macros;
        const d = director.update(s);
        const dt = Math.min(1 / 30, Math.max(1 / 240, s.dt || 1 / 60));

        // Kick: light a random band (sometimes none). Drop: flood, then decay.
        const kickHit = d.kickAge < lastKickAge && d.kickAge < 0.05;
        lastKickAge = d.kickAge;
        if (kickHit && rnd() < 0.4 + m[1] * 0.6) {
          bandY.value = rnd();
          band.value = 0.5 + m[1] * 0.7;
        } else band.value = Number(band.value) * Math.exp(-dt / 0.18);
        if (d.flash > 0.95 && !lastFlash) dropAt = s.time;
        lastFlash = d.flash > 0.95;
        flood.value = s.time >= dropAt ? Math.exp(-(s.time - dropAt) / 0.9) : 0;
        depth.value = m[0] + (d.phase === 'impact' ? 0.6 : 0);

        post.flash.value = d.flash * 0.8;
        post.negative.value = d.style === 2 ? 1 : 0;
        post.bloom.value = 0.1 + m[2] * 0.5 + d.flash * 0.5;
        post.trails.value = d.flash > 0.2 ? 0 : m[3] * 0.85; // no trails under a flash (grey veil)

        frameShot(d.shot, (d.local * 60) / Math.max(30, s.bpm), s.kick, s.level);
        renderer.setRenderTarget(target);
        post.render();
      },
      debug: () => ({ ...director.current }),
      resize(w, h) {
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      },
      dispose() {
        post.dispose();
        material.dispose();
        geometry.dispose();
        key.tex.dispose();
      },
    };
  },
});
