# RAN（乱）— notes

## Concept

「シンプルに音によって光で暴れるようなイメージ」. Reference: a screen recording the user sent of sakrmusic's
audio-visual loops — ink-fine particle trails on white erupting from a horizon disc (spears, fountains, vortex rings,
spiral galaxies, hair balls), now and then flipped to white light on black. No fractal: just strands of light that the
sound throws around.

## How

- 524 288 particles (compute), each drawn as a hairline from its position back along its velocity (LineSegments,
  two vertices per particle), accumulated additively with a decaying feedback buffer (a long exposure).
- Finish: ink on paper (density → 1 − e^(−d·gain), dark strands on warm white) ↔ light on black (bloom).
- Particles spawn in 40 clusters on the disc so strands travel and read as bundles.
- Forms (bars switch them, more with Form rate): fountain (kicks fire spears from the disc), vortex ring (circulation
  around a ring core), spiral (differential rotation, flattened), hair (low gravity, high curl). Calm leans spiral.
- Build: everything is drawn into one rising needle; the exposure lengthens with tension.
- Drop: an explosion from above the disc, then light on black for two bars, then a ring.
- Shots: horizon, low under the spears, top-down, impact pull-back, build push, orbit. A cut starts a fresh exposure.

## Feedback log

- 2026-10-08 · MIZUKAGAMI (liquid-chrome fractal) was "イメージが違うな". Wanted light running wild with the sound, simply;
  sent the sakrmusic recording as the image.

## Next

- Strands are still softer (brush/smoke) than the reference's crisp hairs; try more particles with less ink each and a
  shorter exposure, or 2-px lines.
- Ask whether light-on-black should be the default rather than the drop state.
