# SUBLIMATION（昇華）— notes

## Concept

「コンピューター計算で作られる世界の昇華」. Source: the user's Fract renderer (`~/development/my_work/Fract`, Python:
progressive Mandelbrot with Y2K palettes and a CRT finish). Plain fractal zooms bore the user, so the subject is the
act of computing, not the shape: every pixel is one c of z → z² + c. Points that escape to infinity are proved "not
the world" and sublimate; the points that never leave (the set) are the only thing that stays solid.

## Choreography

| Phase | What happens |
|---|---|
| Compute (calm → groove) | Raster scan like an old machine, one pass per bar (two when calm), blocks 16 → 8 → 4 → 2 → 1 px. Kicks push extra iterations, so the boundary gains detail on the beat. Palette cycling (Fractint-style) drifts and jumps on kicks. |
| Build | The scan slows to a stop, the scan line flickers, escaped pixels tremble with tension. |
| Drop | Every escaped pixel flies along its own orbit z₁ = c, z₂ = c² + c, … (compressed, expanding, rising at its own rate). Fast escapers leave first, boundary pixels hesitate longest. The world's edge lights up. Orbits of random c accumulate into a Buddhabrot ghost (escape after > 10 steps only, so it reads as wisps, not shells). |
| After | 40 beats later (or 48 beats after a finished computation without a drop) the machine reboots at the next place: whole set, Seahorse Valley, the top spiral arms, Elephant Valley, the needle mini-brot. |

Shots: 0 monitor, 1 grazing over the relief (the set is a black plateau), 2 close drift, 3 impact pull-back,
4 build dolly toward the scan line, 5 orbit. Director styles = palettes: teal (the screenshot), vaporwave, electric, ember.

## Macros

Compute (scan speed, iterations), Pixel (coarsest block that stays), Cycle (palette cycling), Relief (terrain height),
Gas (flight speed and spread), Ghost (nebula), CRT (scanlines, chroma fringe, grain, vignette), Glow.

## Prints

Stills rendered at 3840×2160 with `window.__lab.still({ name, at, buildAt: 11, dropAt: 16 })` in the lab (deterministic:
the world is recreated before every capture). Saved under `library/prints/sublimation/` (not in git):
01-compute (4.5 s), 02-sublimation (17.5 s), 03-vapor (21.4 s), 04-boundary (23 s), 05-afterimage (28 s); alternates/.

## Feedback log

- 2026-10-07 · Brief: use the retro pixel fractal, but not as a plain fractal video. Concept from the user:
  「コンピューター計算で作られる世界の昇華」. Asked for framed stills of the best moments.

## Known limits / next

- float32: places deeper than a span of ~1e-4 break into blocks. Could become a deliberate "edge of the computed world"
  shot (perturbation or double-single arithmetic needed for real deep zooms).
- The ghost is a flat plane; a volumetric version (orbit index as depth) would hold up better in the orbit shot.
