# Task: port the DeckEngine to WebGPU (three/webgpu + TSL)

You are Codex in the SHIKI repo. Read `AGENTS.md`, `src/engine/DeckEngine.ts` (+ `src/engine/deck/*`,
`src/engine/transitions/*.frag`, `src/engine/fx/*.frag`, `src/engine/finish.frag`, `src/engine/passes.ts`) and the new
WebGPU contract `src/engine/gpu/types.ts` + `src/engine/gpu/signals.ts` first.

## Why

The user approved moving rendering to WebGPU. Works will become 3D worlds with compute particles (millions of stateful
particles), skinned creatures from Meshy GLB files, and cinematic post-processing. `WebGPURenderer` does not accept
GLSL `ShaderMaterial`, so every pass must be rebuilt with TSL node materials. three is 0.186 (`three/webgpu`,
`three/tsl`, typings in `@types/three`).

## Files you own

- `src/engine/gpu/DeckEngine.ts`, `src/engine/gpu/passes.ts`, `src/engine/gpu/transitions.ts`, `src/engine/gpu/fx.ts`,
  `src/engine/gpu/finish.ts`, and `src/engine/gpu/*.test.ts`.
- Read-only: everything else. Reuse `src/engine/deck/scheduling.ts` and `src/engine/deck/strobe.ts` as they are.
  Do not touch `src/control/**`, `src/output/**`, `works/**`, `tools/**` (the orchestrator integrates).

## What to build

`GpuDeckEngine` — the same responsibilities and public API as `DeckEngine` (decks A/B, per-deck knobs/macros/presets,
`onAir`, `mix`, `take`/`pending`/`active`/`progress`, master FX with the same ids and amounts, `blackout`/`freeze`/`safe`/
`setSafe`, `syncState`/`applySync`, `layout` multiview with deck previews, `setPreview`, `renderAt(now)`, `fps`,
`exposure`, `signals` provider, `onError`/`onLoad`, every-frame canvas size check, `dispose`), with these differences:

- `static async create(opts): Promise<GpuDeckEngine>` — builds `new WebGPURenderer({ canvas, antialias: false })`
  and awaits `renderer.init()`. If WebGPU is unavailable, three falls back to its WebGL2 backend; that must still work.
- `load(deck, module, opts?): Promise<boolean>` and `setSafe(module): Promise<boolean>` — `module.create()` may be
  async. Fail-safe exactly like today: create, render one trial frame into a small target, and if anything fails keep
  the deck's previous instrument and call `onError`. On the WebGPU backend also catch GPU validation errors around the
  trial render: `device.pushErrorScope('validation')` … `await device.popErrorScope()` (device =
  `renderer.backend.device` when present). Ignore stale results if another load for the same deck started meanwhile.
- Deck targets: `RenderTarget` (three/webgpu) half-float, **with a depth buffer** (worlds render 3D scenes).
- Fullscreen passes: `QuadMesh` + node materials (`NodeMaterial` / `MeshBasicNodeMaterial` with `colorNode`/
  `fragmentNode`). Feed textures with `texture(...)` nodes and swap their `.value` when targets ping-pong.
- Port the math of the 5 transitions (cut, dissolve, luma-wipe, displace, feedback-melt), the 5 master FX (feedback,
  kaleido, rgb-split, grain, strobe ≤ 8 Hz via `StrobeClock`) and the finishing pass (exposure → ACES → vignette →
  sRGB → grain) to TSL with the same results as the GLSL. Colour: deck targets stay linear; the finishing pass is the
  only place that converts to display. Make sure three does not tone-map or colour-convert a second time (set the
  renderer's `toneMapping`/`outputColorSpace` and/or the pass materials accordingly) and document the choice in a
  comment.
- Multiview (`layout`): program + deck previews as viewports of one canvas, like `present()` today. Check three's
  viewport/scissor conventions on the WebGPU backend (y origin) and keep both backends correct.

## Tests

No GPU in your sandbox: unit-test with mocks like `src/engine/DeckEngine.test.ts` does (fail-safe load incl. async
rejection and stale loads, takes/scheduling integration, freeze/blackout/safe, sync round-trip, preview gating,
dispose releases everything). `npx tsc --noEmit` and `npx vitest run src/engine` must pass. The orchestrator verifies
the real rendering in the browser.

Final message (Japanese is fine): the public API diff vs `DeckEngine`, the colour-space decision, anything the
orchestrator must check visually.
