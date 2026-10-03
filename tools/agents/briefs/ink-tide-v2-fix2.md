# Task: INK TIDE v2 — second fix: artifacts in build/drop, emptiness after the drop

You own `works/ink-tide/` only (read `AGENTS.md`). Thank you — the freeze is fixed and the ink now lives.

## Evidence (attached contact sheet, 1 frame per second)

The orchestrator rendered 16 s with the deterministic offline capture (`window.__shiki.offline`, 30 fps fixed step,
scripted signals): 128 BPM groove with kicks 0–4 s, **build 4–10 s** (no kick, `tension` ramps 0 → 1, highs rise),
**drop at 10 s** (`drop` = 1 then decays with τ = 2.2 s), groove again after.

1. 0–4 s: beautiful — glossy swirls evolve slowly. Keep this.
2. From ~7 s (tension ≈ 0.5) through ~12 s: **blocky rectangular artifacts**, hard horizontal smears and grey
   squares hugging the right and bottom edges. It looks like the simulation blows up or samples outside the domain
   (boundary handling, velocity magnitude, the gather attractor pinned at the edge, or history/replay textures being
   mixed with the wrong layout).
3. 12–16 s: after the drop almost everything is gone — a single filament in the lower left (the flood into the calm
   area works conceptually) but the frame stays nearly empty for ~6 s.

## What to do

- Make build and drop artifact-free at any tension: proper wall boundaries (no-slip or free-slip, no sampling outside
  the domain), clamp velocity magnitude per step, fade dye near the walls, keep the gather attractor inside the frame
  (e.g. around x 0.72, y 0.6) so the ink tightens into a taut, glossy strand *in view*, not smeared into the edge.
- Drop: keep the reversal → collapse into one drop → curved burst that crosses into the calm left, but the ink must
  **re-bloom** within ~2 s after the burst so the frame never sits empty for long.
- Add a test that runs the full simulation path headlessly if you can (you mentioned native rendering) or at least
  asserts velocity/dye bounds stay finite and inside limits over the 16 s scripted timeline above.
- Keep performance work from the previous pass.

Done when `npx tsc --noEmit` and `npx vitest run works/ink-tide` pass. Final message (Japanese is fine): what caused
the artifacts and what you changed.
