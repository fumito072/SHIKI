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
- Up to 8 macros, values 0..1. `mod` adds `signal * amount` on top of the knob. Signals: `low mid high level onset kick beat bar`.
- Time comes only from uniforms (`uTime`, `uBeats` …). Never use `Date.now()`/`performance.now()` inside a work; the same frame inputs must give the same image (the output window re-renders from the same state).
- Allocate GPU resources in `create`, release all of them in `dispose`. Implement `resize(w, h)` if you own size-dependent targets.
- Budget: 60 fps at 1920×1080 on Apple Silicon, with headroom (one instrument may run in two windows).

### Shader conventions

- `shaderPrelude(manifest)` declares the standard uniforms and one `#define M_<ID> uMacro[i]` per macro (`energy` → `M_ENERGY`).
- Standard uniforms: `uTime uResolution uFrame uBpm uBeat uBar uBeats uLow uMid uHigh uLevel uOnset uKick uMacro[8]`.
  `uBeat`/`uBar` are 0..1 phases; `uBeats` is the continuous beat count; audio values are 0..1 envelopes.
- Fullscreen fragment shaders receive `varying vec2 vUv;` (0..1). Write `gl_FragColor`. `texture2D` and `texture` both work (three.js compiles as GLSL ES 3.00).
- Shared chunks: `#include <shiki_noise>` (`hash11 hash12 hash22 snoise(vec3) fbm(vec3) curl2(vec2,float)`), `#include <shiki_color>` (`srgb() aces() luma()`).
- Helpers in `src/engine/passes.ts`: `FullscreenPass`, `PingPong` (feedback), `createTarget`, `CopyPass`.

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
