// MOONSEA — a breaking wave of silver particles travelling left to right.
attribute float aSeed;
varying float vBright;
varying float vWarm;

#include <shiki_noise>

void main() {
  float aspect = uResolution.x / uResolution.y;
  float s0 = position.x;   // along the wave
  float o = position.y;    // across the thickness
  float r = position.z;    // size / depth / spray

  // Density: hide a share of the cloud.
  float keep = step(aSeed, 0.12 + 0.88 * M_DENSITY);

  // Flow along the wave.
  float speed = mix(0.006, 0.045, M_DRIFT) * (0.6 + 0.8 * r);
  float s = fract(s0 + uTime * speed);

  // Wave spine: born low on the water at the left, sweeping up into a curling crest on the right.
  float lift = smoothstep(0.05, 0.92, s);
  float energy = 0.55 + 0.75 * M_ENERGY + 0.25 * uKick;
  float x = mix(-1.25, 1.25, s) * aspect;
  float rise = pow(lift, 2.2) * 0.95 * energy;
  float y = -0.31 + rise * 0.8 + 0.06 * sin(s * 6.0 - uTime * 0.5) * (0.4 + lift);
  // The crest folds forward over itself near the right edge.
  float fold = smoothstep(0.7, 1.0, s);
  x -= fold * fold * 0.25 * aspect * energy;
  y += fold * 0.12 * energy;

  // A body, not a line: gaussian-ish spread, wide everywhere, widest at the crest.
  float n = o * 2.0 - 1.0;
  float spread = n * (0.55 + 0.45 * abs(n));
  float thick = mix(0.06, 0.26, lift) * (0.75 + 0.5 * uLow);
  y += spread * thick;
  x -= spread * thick * 0.6;

  // Turbulence that tears the body into strands.
  vec3 q = vec3(x * 1.2, y * 1.6, uTime * 0.07 + r * 0.25);
  vec2 d = vec2(snoise(q), snoise(q + vec3(17.3, -9.1, 4.7)));
  vec2 d2 = vec2(snoise(q * 3.1 + 5.0), snoise(q * 3.1 - 11.0));
  x += (d.x * 0.08 + d2.x * 0.025) * (0.4 + M_ENERGY);
  y += (d.y * 0.06 + d2.y * 0.02) * (0.4 + M_ENERGY);

  // Spray thrown above the crest.
  float sprayShare = 0.35 * M_SPRAY;
  float isSpray = step(1.0 - sprayShare, r) * smoothstep(0.45, 0.8, s);
  float age = fract(r * 13.7 + uTime * 0.18);
  y += isSpray * (age * age * 0.45 + 0.05) * energy;
  x += isSpray * age * 0.22;

  // Brightness: dim and sparse where the wave is born, brightest at the crest, core denser than edges.
  float ends = smoothstep(0.0, 0.22, s) * (1.0 - smoothstep(0.94, 1.0, s));
  float core = 1.0 - 0.55 * abs(n);
  float b = mix(0.35, 1.0, r) * (0.25 + 0.75 * lift) * ends * core;
  b *= 0.75 + 0.25 * sin(uTime * 2.3 + aSeed * 61.0);
  b += step(0.985, fract(aSeed * 91.7 + uTime * 0.37)) * (0.6 + 2.0 * uHigh) * lift;
  b *= mix(1.0, 1.0 - age, isSpray);
  vBright = b * keep;
  vWarm = step(0.995, aSeed);

  float size = (0.9 + 2.4 * r * r) * (uResolution.y / 1080.0);
  gl_PointSize = keep > 0.5 ? size : 0.0;
  gl_Position = vec4(x / aspect, y, 0.0, 1.0);
}
