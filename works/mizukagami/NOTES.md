# MIZUKAGAMI（水鏡）— notes

## Concept

A liquid mirror that is a fractal (in the spirit of null², Ochiai's mirror-membrane pavilion: the surface ripples and
distorts what it reflects) and a fractal that will not let you reach the bottom. The Mandelbrot set is mercury: flat and
black far away, a meniscus rising at the set's edge, slow waves rolling in; lights only ever graze it, so a flat mirror
stays black and only edges, waves and ripples shine.

## Devices (prediction error)

| Device | How |
|---|---|
| Endless dive | The period-3 mini-brot on the needle is the set scaled by 1/K (K = 61.74; cusp 0.25 → −1.75, tip −2 → −1.78644). Zooming at the similarity's fixed point F = −1.78292 returns to the same picture every K×; the last 18 % of each cycle cross-fades to the frame one level up, so there is never a seam. |
| Water that opens onto the other side | Drops (some downbeats, more with the Drops knob; a big one on the drop) open a ring showing the Julia set of the c where they fell — the Mandelbrot set is the map of all Julia sets — then the ring runs backwards and closes. |
| Stillness after motion | A build eases the dive to a dead stop; after a long dive the still frame seems to flow backwards (motion aftereffect). |
| Inside out | On the drop a Möbius fold w / (1 − t·w) pulls infinity onto the screen for two bars and figure/ground swap (the black world lights up, the outside drains). |
| Exhale | In calm passages the dive slowly reverses. The lights turn against the waves. |

Accent per director style: acid green, oil-slick violet, cold blue, white gold (one accent on black).

## Feedback log

- 2026-10-08 · After SUBLIMATION: old-CG pixel squares do not suit the user as video (keep them for prints). Wanted
  "beautiful, smooth (ぬるぬる) WebGPU expression like Yoichi Ochiai's null²".
- 2026-10-08 · A first version nested the fractal in browser windows and a monitor in space (Matryoshka idea):
  「ブラウザダサいからやめよう。ただ水の感じとかはいいからそういう表現をフラクタルと掛け合わせて頭がバグる映像体験を作りたい」.
  Browser/monitor levels removed; the liquid mirror stays and the recursion became the fractal's own self-similarity.

- 2026-10-08 · 「水はダサいから水一度取り外そう」 → removed the kick ripples, the drop windows (Julia rings), the rolling
  waves and the membrane wobble. Kicks now flash the rims instead (Pulse knob). Kept: the endless dive, the build's
  dead stop, the drop's fold and figure/ground swap, the metal rims.

- 2026-10-08 · 「DROPの灰色の光は弱めて」「フラクタルの中に入っていく…マンデルブロからカントール集合、シェルピンスキー、コッホ、
  ペアノ、高木、ヒルベルト、マンデルブロ、ジュリア、メンガー、ロマネスコ、バーニングシップ、リアプノフ、バーンズリーのシダ…
  どんどん現れる映像にして、入りながら色とかも変化していく」 → rebuilt as a descent through thirteen worlds
  (works/mizukagami/fractals.ts): Mandelbrot → Julia → Burning Ship → Lyapunov → Cantor dust → Sierpinski → Koch →
  Takagi → Peano → Hilbert → Menger (ray-marched) → Barnsley fern (chaos game) → Romanesco (phyllotaxis) → Mandelbrot.
  Each world dives at its own point (self-similar where exact: Cantor at (¼,¼) ×9, Sierpinski at (2A+B)/3 ×4,
  Peano centre ×9, Menger corner ×3, fern tip ×1/0.85); in the last 35 % of its stretch the next world opens from the
  centre with a ragged rim; colours change with the worlds. Drop flash cut to 0.06.
- Escape-time worlds are drawn as thin inward-flowing bands of escape time plus a faint edge: drawn as distance-field
  lines, deep views are so dense that the screen whites out. The derivative is kept scaled (log scale) so it never
  overflows float32.

## Next

- The inverted (inside-lit) state is brief and could be richer.
- Deeper dives need double-single or perturbation arithmetic (float32 is fine up to the K× cycle used here).
