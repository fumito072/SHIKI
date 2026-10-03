# Task: Step 2 core — DeckEngine (two decks, transitions, master FX, panic)

You are Codex in the SHIKI repo. Read `AGENTS.md` and `docs/philosophy.md` first.

## Files you own (create only these; do not edit anything else)

- `src/engine/DeckEngine.ts` (+ small helpers under `src/engine/deck/` if useful)
- `src/engine/transitions/*.frag`, `src/engine/fx/*.frag`
- `src/engine/DeckEngine.test.ts`, `src/engine/deck/*.test.ts`

The existing `src/engine/Engine.ts` stays as is; the orchestrator will switch the control/output windows over to your
class afterwards. Reuse `passes.ts`, `glsl.ts`, `types.ts` (read-only for you).

## What to build

A `DeckEngine` with the same responsibilities as `Engine` (renderer, rAF loop, fail-safe `load`, finishing pass,
`renderAt(now)` for offline capture, `signals` provider, `exposure`, `fps`) but with **two decks**:

- `load(deck: 'A' | 'B', module, opts?)` — fail-safe per deck exactly like `Engine.load` (create + trial render +
  shader-error capture; on failure keep that deck's previous instrument and report via `onError`).
- Per-deck knobs: `knobs.A`, `knobs.B` (Float32Array(8)), `resetKnobs(deck)`, `applyPreset(deck, name)`;
  effective macros (knob + `mod`) computed per deck from the same signals.
- `onAir: 'A' | 'B'` and a crossfader `mix` 0..1 (0 = A, 1 = B).
- **Transitions** (fragment shaders mixing two textures with a progress uniform): `cut`, `dissolve`, `luma-wipe`
  (wipe along the luminance of the incoming deck), `displace` (outgoing image pushed by the incoming one's gradient),
  `feedback-melt` (the outgoing image melts into the incoming through a decaying feedback buffer).
- `take(opts: { transition, beats: number, quantize: 'now' | 'beat' | 'bar' | 'phrase16' | 'phrase32' })` schedules a
  transition from the on-air deck to the other one, starting at the next quantize boundary computed from
  `signals.beats`, lasting `beats` beats; when finished, `onAir` flips and `mix` settles. Expose `pending` (scheduled
  start beat, transition) and `progress` so the UI can show a countdown. Pure scheduling math in a separate module
  with unit tests (boundaries, phrase alignment, a take requested mid-transition).
- Only render the off-air deck while it is needed (preview or transition) — keep two-deck cost low.
- **Master FX** after the mix, before the finishing pass, each with an amount 0..1 and on/off:
  `feedback` (trails), `kaleido` (segments), `rgb-split` (beat-synced offset), `grain`, `strobe`
  (hard cap at 8 Hz for photosensitivity, beat-synced). Order fixed; skip passes that are off.
- **Panic**: `blackout(on)`, `freeze(on)` (hold the last mixed frame), `safe()` (instantly cut to whatever is loaded
  in a designated safe deck slot — simplest: a third optional `safe` instrument set via `setSafe(module)`).
- Expose per-deck preview textures so the UI can draw small deck previews (e.g. `previewTexture('A')`), or a method to
  blit a deck into a given render target.

## Constraints

- Budget: two works + transition + FX ≥ 60 fps at 1920×1080 on Apple Silicon.
- Time only from signals. Dispose everything. No new dependencies.
- `npx tsc --noEmit` and `npx vitest run src/engine` must pass.

Final message (Japanese is fine): the public API (method list with one line each), how scheduling works, costs, and
what the orchestrator must wire up in the control/output windows.
