# SHIKI — agent guide

SHIKI is a closed, personal real-time visual instrument for VJ performance.
AI agents author audio-reactive "instruments" (works); the human gives feedback and performs them live.
Project docs are in Japanese (`docs/`); code, comments and commit messages are in English.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server on http://localhost:5173 (control window). Output window: `/output.html` |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `works/` |
| `npm test` | Vitest unit tests (`*.test.ts`) |
| `npm run gen:testtrack` | Writes `public/test/testtrack-128.wav` (synthetic 128 BPM loop for audio checks) |

## Layout

```
src/engine/      Engine (render loop, fail-safe hot swap, finishing pass), Clock, GLSL prelude, passes
src/audio/       AudioEngine (mic / file), Analyzer (bands, onsets), BeatTracker
src/control/     Control window (dev UI)
src/output/      Output window (projector / external display), driven over BroadcastChannel
src/works/       Work registry (auto-discovers works/*/index.ts)
works/<id>/      One instrument per folder: index.ts + *.frag / *.vert
docs/            Roadmap, decisions, UI spec, agent roles (Japanese)
design/          Design tokens, canvas sources, key visuals
tools/agents/    Codex harness (codex-run.sh, briefs/)
tools/codex-mcp/ MCP server that exposes the Codex harness to Claude Code
```

## Instrument contract (works)

A work is a folder `works/<id>/` whose `index.ts` default-exports `defineInstrument({ manifest, create })`.
Folders starting with `_` are ignored by the registry.

```ts
import type { InstrumentManifest } from '../../src/engine/types';
import { defineInstrument } from '../../src/engine/types';
import { FullscreenPass } from '../../src/engine/passes';
import { stdUniforms, updateStdUniforms, shaderPrelude } from '../../src/engine/glsl';
import frag from './main.frag?raw';

const manifest: InstrumentManifest = {
  id: 'example', name: 'EXAMPLE', nameJa: '例',
  mood: ['calm'], energy: [0.2, 0.6], tempo: 'free',
  macros: [
    { id: 'energy', label: 'Energy', default: 0.5, mod: { source: 'low', amount: 0.3 } },
  ],
  presets: { calm: { energy: 0.2 } },
};

export default defineInstrument({
  manifest,
  create({ renderer }) {
    const u = stdUniforms();
    const pass = new FullscreenPass({ fragmentShader: shaderPrelude(manifest) + frag, uniforms: u });
    return {
      render(frame, target) { updateStdUniforms(u, frame); pass.render(renderer, target); },
      dispose() { pass.dispose(); },
    };
  },
});
```

Rules:

- `render(frame, target)` must fully draw `target` every frame (a HalfFloat render target). Output **linear HDR** color; the engine applies exposure, ACES tone mapping, vignette, grain and sRGB encoding afterwards. Palette hex values are sRGB: convert with `srgb()` from `<shiki_color>`.
- Up to 8 macros, values 0..1. `mod` adds `signal * amount` on top of the knob. Signals: `low mid high level onset kick beat bar tension drop`.
- Time comes only from uniforms and `frame.signals` (`uTime`, `uBeats`, `dt` …). Never use `Date.now()`/`performance.now()` inside a work.
- Stateful simulations (feedback, fluids, accumulated clocks) are welcome. The output window runs its own instance from the same signals, so small divergence between preview and output is acceptable; the output is the master.
- Allocate GPU resources in `create`, release all of them in `dispose`. Implement `resize(w, h)` if you own size-dependent targets.
- Budget: 60 fps at 1920×1080 on Apple Silicon, with headroom (one instrument may run in two windows).

### Shader conventions

- `shaderPrelude(manifest)` declares the standard uniforms and one `#define M_<ID> uMacro[i]` per macro (`energy` → `M_ENERGY`).
- Standard uniforms: `uTime uResolution uFrame uBpm uBeat uBar uBeats uLow uMid uHigh uLevel uOnset uKick uTension uDrop uMacro[8]`.
  `uBeat`/`uBar` are 0..1 phases; `uBeats` is the continuous beat count; audio values are 0..1 envelopes.
  `uTension` rises slowly through breakdowns/builds; `uDrop` is an envelope (1 → 0 over ~2 s) fired when the kick returns
  after a build or when the performer hits DROP. The clock knows where the next beat is: `1.0 - uBeat` is the time to it.
- Fullscreen fragment shaders receive `varying vec2 vUv;` (0..1). Write `gl_FragColor`. `texture2D` and `texture` both work (three.js compiles as GLSL ES 3.00).
- Shared chunks: `#include <shiki_noise>` (`hash11 hash12 hash22 snoise(vec3) fbm(vec3) curl2(vec2,float)`), `#include <shiki_color>` (`srgb() aces() luma()`).
- Helpers in `src/engine/passes.ts`: `FullscreenPass`, `PingPong` (feedback), `createTarget`, `CopyPass`.

### Artistic intent (read docs/philosophy.md — it overrides polish)

The user's aim: **maximize the gap between what the brain predicts and what the retina receives, so the brain glitches;
destroy the boundary lines of our world.** Consequences for every work:

- Never just vibrate with the audio. Amplitude jitter is predictable and boring. Audio drives **choreography**:
  tension → release, deformation with inertia (stretch, overshoot, settle), afterglow.
- Build a learnable regularity first, then violate it at musical moments (`uDrop`, phrase starts) — briefly and locally,
  or the brain re-learns the new rule.
- Prediction-error devices: anticipation (move just *before* the beat), time reversal (unmixing, ripples converging),
  impossible physics (liquid rising against gravity), reflections that disagree with their source, figure/ground or
  inside/outside inversion, motion aftereffect (long steady flow then a sudden stop), dissolving boundaries.
- Stillness is a weapon: the error is largest after calm.

### Taste rules (do not break)

- No rainbow gradients, no neon cyberpunk, no generic galaxies, no lens-flare spam.
- Avoid centred, symmetric compositions; keep generous negative space.
- Motion is slow and organic by default; react to the music with restraint (attack/release, not jitter).
- Limited palettes (2–3 hues + neutrals). Fine grain, depth, haze over flat fills.

## Working rules for agents

- Touch only the files your task assigns to you. If you need a change elsewhere, say so in your final message instead of editing.
- No new dependencies and no network access unless the task says so.
- Before finishing: run `npm run typecheck` and the tests relevant to your files; report the results honestly.
- Keep code comments short and in English. Do not commit; the orchestrator (Claude Code) reviews and commits.
- Never print or commit secrets.
