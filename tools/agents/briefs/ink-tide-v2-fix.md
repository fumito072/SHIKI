# Task: INK TIDE v2 — it does not move, and it is too slow

You are Codex working in the SHIKI repository. You own `works/ink-tide/` only (same rules as before; read `AGENTS.md`).

## What the orchestrator observed in a real browser (Chrome, Apple M5 Max, preview 1542×867)

The look is excellent — glossy black liquid with silver highlights, exactly the "ぬるぬる" the user asked for. But:

1. **It is frozen.** Four snapshots over ~5 s — before, during a held BUILD, 0.9 s and 2.4 s after a DROP — are
   pixel-for-pixel the same image. A 15 s clip (build → drop) shows no motion at all. The same happened right after
   loading the work. The test track was playing (signals were live: kick/low/high moving, `uBeats` advancing).
   Prime suspect: `index.ts` only calls `simulate()` when `dance.replay < 0`; `replay` may be stuck at ≥ 0
   (e.g. after the first `capture(true)`, after repeated drops, or because `dropStarted` re-triggers). Also check the
   `frame.signals.time === lastTime → dt = 0` path and the engine's trial render in `Engine.load()` (one frame is
   rendered into a 64×36 scratch target at load time with `dt = 0`).
2. **It is slow: 23–25 fps** where MOONSEA (450k particles + raymarched background) runs at 116 fps in the same setup.
   Likely causes: the single "uber" fluid shader switched by `uOperation` (every pass pays for every branch's samplers
   and math), ~3 sub-steps × (20 Jacobi + 4 passes) per frame, and the full-resolution ink pass. Target: ≥ 90 fps at
   1542×867 so that two windows stay ≥ 60 fps.

## What to do

- Find and fix why the simulation stops. Between events the ink must keep drifting slowly (stillness is relative —
  the brain should still see a living liquid), kicks must bend it, BUILD must gather it, DROP must reverse then burst.
- Add a test that runs the choreography state machine (`stepDance` etc.) over a realistic 60 s signal timeline
  (groove → breakdown/build with rising tension → drop → groove, plus two manual drops 3 s apart) and asserts the
  simulation is stepping again within ~2 s after each drop and never stays in replay forever.
- Make it fast: one small shader per fluid operation (advect / divergence / jacobi / project / dye), fewer Jacobi
  iterations if the look holds (12–16), at most 1–2 sub-steps, and cheaper normals/refraction in the full-res pass.
  Keep the look.
- Keep everything else from v2 (choreography design, macros, presets).

Done when: `npx tsc --noEmit` and `npx vitest run works/ink-tide` pass. In your final message (Japanese is fine):
the root cause of the freeze, what you changed for performance and your estimate of the cost per frame.
