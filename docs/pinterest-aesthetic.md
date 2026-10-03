# Pinterest aesthetic — what the user saves

Source: the user's Pinterest saves (78 usable images, contact sheet at
`~/development/fumito_proj_2026/stableDiffusion_LoRA/data_raw_contact.png`) and the style LoRA trained on one cluster of
them (`fumito_fila`, trigger `fmtfila`). The images belong to other artists: use them to understand taste, never copy a
composition. Agents making images or works read this next to `docs/taste.md`.

## Recurring families

| Family | What it looks like | Share |
|---|---|---|
| Chrome organics | liquid-metal filaments, tendrils and roots, mirror-polished biomorphic sculptures, branching growth; often on pure black or pure white | largest |
| Proliferation | clusters that multiply — spheres, bubbles, cells, coral, fungal branching, networks of threads; dense centre, sparse edges | large |
| Iridescence | oil-slick rainbows, thin-film interference, prism flares on dark ground | medium |
| Particle and flow | long-exposure particle streams, smoke, waves of points, orbits, starbursts, a single glowing ring in the void | medium |
| Glitch and old UI | Y2K desktops, pixel corruption, scanlines, datamosh over nature or bodies, CRT screens | medium |
| Dark nature | fog, deep sea, mist over water, night forest; quiet and huge | small |
| The eye | macro irises, eyes repeated as pattern | small |
| Fractal / topographic | Mandelbrot edges, contour lines, cracked earth, veins | small |

## Constants across families

- High contrast: a luminous subject against near-black (or bleached white). Large negative space.
- Materials over objects: chrome, liquid, glass, smoke, plasma. Surfaces catch light and bend it.
- Organic growth rendered with a digital, synthetic finish — nature that has become technology, or the other way round.
- Palette: mostly silver / graphite / black, punctured by one saturated accent (oil-slick spectrum, red, electric blue,
  acid green). Rarely pastel.
- Scale ambiguity: you cannot tell if it is a microbe or a monument. Good for prediction error.

## How to use it

- In a round of key-visual candidates, at least one candidate should come from a family the brief does not obviously
  suggest. That widens the range without leaving the user's taste.
- The `pinterest-lora` engine (SDXL + `fmtfila`) renders the chrome-organics / proliferation family. Prompt it with
  subject, composition, background and light only; it adds the material and style itself. Weight 0.65–0.8 is the useful
  range.
- Avoid: flat vector illustration, cute characters, warm photographic realism, text in the image, generic "AI cyberpunk"
  neon cityscapes.
