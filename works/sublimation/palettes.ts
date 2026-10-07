// Palettes of the user's Fract renderer (~/development/my_work/Fract/python/render/palette.py) plus the teal of the
// screenshot that started this work. Baked into one storage buffer: PALETTES rows × 256 linear RGB entries, every row
// cyclic so palette cycling never shows a seam (the gradients that run black → white are mirrored).
type Stop = [number, [number, number, number]];

const TEAL: Stop[] = [
  [0.0, [0, 214, 186]],
  [0.3, [60, 248, 214]],
  [0.5, [150, 140, 206]],
  [0.62, [118, 116, 188]],
  [0.8, [0, 205, 178]],
  [1.0, [0, 214, 186]],
];
const VAPOR: Stop[] = [
  [0.0, [0, 0, 0]],
  [0.1, [10, 10, 40]],
  [0.25, [70, 0, 120]],
  [0.45, [255, 0, 140]],
  [0.65, [0, 255, 220]],
  [0.85, [255, 255, 120]],
  [1.0, [255, 255, 255]],
];
const ELECTRIC: Stop[] = [
  [0.0, [0, 0, 0]],
  [0.2, [0, 80, 255]],
  [0.45, [255, 0, 200]],
  [0.7, [0, 255, 170]],
  [1.0, [255, 255, 255]],
];
const EMBER: Stop[] = [
  [0.0, [0, 0, 0]],
  [0.18, [255, 0, 90]],
  [0.35, [255, 160, 0]],
  [0.55, [0, 255, 180]],
  [0.78, [0, 120, 255]],
  [1.0, [255, 255, 255]],
];

/** Row order = director style: 0 teal (the screenshot), 1 vaporwave, 2 electric, 3 ember. */
const ROWS: { stops: Stop[]; mirror: boolean }[] = [
  { stops: TEAL, mirror: false },
  { stops: VAPOR, mirror: true },
  { stops: ELECTRIC, mirror: true },
  { stops: EMBER, mirror: true },
];
export const PALETTES = ROWS.length;
export const PALETTE_SIZE = 256;

const toLinear = (c: number) => {
  const x = c / 255;
  return x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
};

function sample(stops: Stop[], t: number): [number, number, number] {
  let j = 0;
  while (j + 1 < stops.length && t > stops[j + 1][0]) j++;
  const [t0, c0] = stops[j];
  const [t1, c1] = stops[Math.min(j + 1, stops.length - 1)];
  const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
  return [0, 1, 2].map((k) => c0[k] + (c1[k] - c0[k]) * f) as [number, number, number];
}

/** RGBA float data (alpha unused), linear, PALETTES × PALETTE_SIZE entries. */
export function paletteData(): Float32Array {
  const out = new Float32Array(PALETTES * PALETTE_SIZE * 4);
  ROWS.forEach((row, r) => {
    for (let i = 0; i < PALETTE_SIZE; i++) {
      const u = i / (PALETTE_SIZE - 1);
      const t = row.mirror ? 1 - Math.abs(2 * u - 1) : u;
      const [cr, cg, cb] = sample(row.stops, t);
      const o = (r * PALETTE_SIZE + i) * 4;
      out[o] = toLinear(cr);
      out[o + 1] = toLinear(cg);
      out[o + 2] = toLinear(cb);
      out[o + 3] = 1;
    }
  });
  return out;
}
