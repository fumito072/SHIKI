# Task: INK TIDE v2 — liquid choreography that breaks the brain's predictions

You are Codex working in the SHIKI repository. Read `AGENTS.md` (especially "Artistic intent") and
`docs/philosophy.md` first. Those two documents override any instinct toward polish.

## Files you own

Everything under `works/ink-tide/` — you may rewrite it completely (keep the id `ink-tide`).
Do not edit anything else. If the engine lacks something, describe it in your final message.

## The user's feedback on v1 (verbatim, Japanese) and what it means

> INK TIDEは静止画としてはかなりいい。一方で音と連動する際の躍動感が一切ない。ただ音と共鳴するように振動するだけでは
> 何も面白くない。インクであるなら液体のようにぬるぬるしたり曲線に変形したりと表現の幅を広げたい。

- Keep: the still look — palette, the calm left ~40%, fine grain, deep blacks, faint warm highlight.
- Fix: there is no dynamism. Shimmering/vibrating with the audio is explicitly rejected.
- Want: real liquid behaviour — viscous, slimy ("ぬるぬる"), glossy, stretching into curves and filaments.

## The user's aim (verbatim)

> 人間の脳の予測誤差の乖離をデカくして脳をバグらせる。我々の世界の中での境界線を破壊してほしい。

## What to build

1. **A liquid, not smoke.** Use a stateful GPU fluid (velocity + dye ping-pong, semi-Lagrangian advection,
   divergence-free projection with ~20 Jacobi iterations at reduced resolution, optional mild vorticity confinement),
   or an equivalent you can justify. Make it read as *viscous ink*: thick, slow, cohesive bodies with smooth edges
   that stretch into long curved filaments and pinch off — not diffuse fog.
2. **Liquid surface shading.** Treat dye density as a height field: compute normals, add a tight specular sheen and a
   subtle refraction of the background so the ink looks wet and glossy (black ink with silver highlights).
3. **Choreography from the engine signals (no amplitude jitter):**
   - `uKick` → an *elastic* impulse: a curved stroke of force that bends the ink into an arc; the response has inertia
     (ease-out, overshoot, settle over about one beat).
   - **Anticipation:** start that motion slightly *before* the predicted beat (e.g. when `uBeat > 0.85`), so the
     image moves before the sound — a small violation of causality.
   - `uTension` → the ink gathers toward an attractor, thickens, and rises *against gravity* into a taut strand or a
     suspended droplet; surfaces tighten (surface-tension look).
   - `uDrop` → break a boundary. Pick at least one and make it unmistakable:
     (a) **time reversal** — the mixed ink visibly *unmixes* back into a single drop within about one bar, then
     bursts outward into curved filaments; (b) **figure/ground inversion** — ink becomes light and water becomes ink
     for a few beats; (c) the ink floods the calm left 40% (crossing the boundary that was respected all along).
     For (a) with a stateful sim, store a short history or drive a reversible flow clock — your choice, but the reversal
     must be clearly perceivable.
   - `uLow` may modulate viscosity or flow speed slowly; `uHigh` only fine glints on the surface.
4. **Stillness matters.** Between events the ink should drift slowly and almost hold still, so violations land hard.
5. **Macros (≤ 8)** — for example `energy` (mod low), `viscosity`, `gloss`, `stretch`, `tension_gain`, `warmth`,
   `calm`, `reverse` (how strong the time reversal on drop is). Presets `calm` and `surge`.

## Testing the choreography

The repo has a structured test track (`npm run gen:testtrack` → groove, breakdown, build, drop at bar 17). In the
browser the performer can also hold **B** (build → tension) and press **Enter** (drop). You cannot open a browser, so:
keep pure helper logic (envelopes, spring responses, schedules) in plain TS functions and unit-test them in
`works/ink-tide/*.test.ts`. The orchestrator will record clips and review the motion.

## Constraints

- 60 fps at 1920×1080 on Apple Silicon with headroom; the simulation may run at 1/2–1/4 resolution.
- Time only from uniforms / `frame.signals` (`dt` exists). Implement `resize`; release everything in `dispose`.
- `npx tsc --noEmit` and `npx vitest run works/ink-tide` must pass.

Final message (Japanese is fine): the choreography per signal (kick / anticipation / tension / drop), the macros,
performance notes, and anything you want changed outside `works/ink-tide/`.
