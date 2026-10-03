# Task: work "INK TIDE"（墨潮）

You are Codex working in the SHIKI repository. Read `AGENTS.md` first — especially the instrument contract,
shader conventions and taste rules.

## Files you own

Create only files under `works/ink-tide/` (e.g. `index.ts`, `*.frag`). Do not edit anything else.
If the engine is missing something you need, explain it in your final message instead of changing it.

## The look

The attached image (`design/key-visuals/kv01-ink-tide.jpg`) is the approved key visual.

- Millions of ultra-fine white "ink" particles flowing like ink in dark water along curl-noise currents.
- Deep blue-black ground, one faint warm highlight, long-exposure trails, haze and depth.
- Composition: the left ~40% stays calm (negative space); the flow lives right of centre. Never centred or symmetric.
- Palette (sRGB, convert with `srgb()`): `#05070C #12233A #4C6A86 #CFD6DC`, warm highlight `#E3C49B` used sparingly.
- Motion is slow and organic. The user's notes for this work: "slower", "finer grains", "avoid centred composition".

## Suggested technique

- Feedback dye simulation with `PingPong` (0.5–1× resolution): each frame advect the previous dye with a
  curl-noise velocity field (semi-Lagrangian), inject dye from 2–3 slowly wandering emitters right of centre,
  apply decay.
- Fine-grain detail with high-frequency noise so the dye reads as particles, not smoke.
- Final grade: density → palette, subtle warm highlight only in the densest swirl, deep blacks elsewhere.

## Audio and macros

- `kick` → a short injection burst plus a gentle push in the flow. `low` → flow speed. `high` → fine sparkle in the grain.
  Use smooth responses (no jitter).
- Up to 8 macros, for example: `energy` (mod low 0.3), `flow`, `density`, `detail`, `trails`, `warmth`, `swirl`,
  `calm` (strength of the left negative-space mask). Add presets `calm` and `surge`.

## Constraints

- 60 fps at 1920×1080 on Apple Silicon with headroom; the simulation may run at reduced resolution.
- Deterministic per frame (time only from uniforms). Implement `resize`, release everything in `dispose`.
- `npx tsc --noEmit` must report no errors in your files (other files may be under construction by another agent).

Final message: what you built, the macros and audio mapping, performance notes, and anything you would like the
orchestrator to change outside `works/ink-tide/`.
