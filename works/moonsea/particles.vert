// MOONSEA — the sea, pulled up by the moon. Droplets leave the water and fall *upward*;
// with tension they braid into a few wandering strands; on the drop time stops, then they are flung around the moon.
attribute float aSeed;
varying float vBright;

void main() {
  float aspect = uResolution.x / uResolution.y;
  vec2 m = moonAt(uBeats, aspect);
  float s0 = position.x; // across the sea
  float o = position.y;  // depth on the water plane
  float r = position.z;  // size / role

  vec2 p;
  float b;
  float keep;

  if (r > 0.9975) {
    // The beat spout: a few droplets thrown up from where the omen rings converged — each on its own arc.
    float n = floor(uBeats);
    float age = fract(uBeats);
    vec2 src = worldToScreen(rippleSource(n, m));
    float a = (hash11(aSeed * 91.7 + n) * 2.0 - 1.0);
    float v = 0.3 + 0.7 * hash11(aSeed * 17.3 + n * 0.37);
    float t = max(age - 0.12 * hash11(aSeed * 3.7 + n), 0.0);
    float rise = (1.0 - exp(-t * 3.0)) * v * 0.3 * (0.6 + M_ENERGY);
    p = src + vec2(a * (0.03 + 0.25 * rise) + 0.04 * sin(aSeed * 40.0), rise);
    b = (1.0 - age) * 0.5 * M_OMEN * smoothstep(0.0, 0.05, t);
    keep = step(0.4, hash11(aSeed * 7.7 + n));
  } else {
    float pull = clamp(M_PULL * (0.25 + uTide), 0.0, 1.0);
    keep = step(aSeed, 0.06 + 0.94 * clamp(M_DRIZZLE + 0.3 * uTide, 0.0, 0.65));

    float period = mix(5.5, 2.4, uTide);
    float age = fract(uPClock / period + aSeed * 7.13);
    float h = age * age * (0.55 + 0.95 * uTide) * (0.5 + M_ENERGY) * 1.35;
    float y0 = HORIZON - mix(0.55, 0.01, sqrt(o));

    // Calm: droplets leave the whole sea. Tide: they braid into a few strands that wander as they climb.
    float strand = floor(s0 * 5.0);
    float u = fract(s0 * 5.0) * 2.0 - 1.0;
    float wander = snoise(vec3(strand * 7.1, h * 2.2 - uPClock * 0.35, 0.5)) * 0.12
                 + sin(h * 6.0 - uPClock * 1.3 + strand * 2.1) * 0.045;
    float colX = wander + u * u * u * 0.012 * (1.0 + 2.0 * h);
    // Calm spread: dense under the moon, thinning out toward the edges of the sea (no hard edges).
    float c = s0 * 2.0 - 1.0;
    float calmX = sign(c) * pow(abs(c), 1.35) * 1.15 * aspect + (hash11(aSeed * 13.1) - 0.5) * 0.16;
    p = vec2(m.x + mix(calmX, colX, pull) + sin(uPClock * 0.6) * 0.04 * uTide, y0 + h);
    // Near the moon the strands lean into its centre.
    p.x = mix(p.x, m.x + (p.x - m.x) * 0.5, smoothstep(0.3, 1.0, age) * pull * 0.6);

    // Turbulence grows as the droplets near the moon: the strands fray before they arrive.
    float fray = 0.5 + uTide + 2.5 * smoothstep(0.55, 1.0, age) * pull;
    vec3 q = vec3(p * 1.5, uPClock * 0.05 + r * 3.0);
    p += vec2(snoise(q), snoise(q + 11.0)) * 0.028 * fray;

    // After the freeze: flung around the moon in curved paths.
    if (uBurst > 0.001) {
      vec2 d = p - m;
      float ang = uBurst * (1.2 + 1.8 * r) * (hash11(aSeed * 5.1) > 0.5 ? 1.0 : -1.0);
      float cs = cos(ang), sn = sin(ang);
      d = mat2(cs, -sn, sn, cs) * d * (1.0 + uBurst * (0.6 + 1.4 * r));
      p = m + d;
    }

    float fade = smoothstep(0.0, 0.08, age) * (1.0 - smoothstep(0.72, 1.0, age));
    float moonlight = exp(-length(p - m) * 1.3);
    float core = mix(1.0, 1.0 - 0.75 * abs(u), pull);
    b = fade * core * (0.35 + 1.4 * moonlight) * mix(0.5, 1.0, r) * (1.2 + 1.2 * uTide + 1.5 * uBurst);
    b *= (1.0 - 0.45 * o) * mix(1.0, 0.3, pull);
  }

  vBright = b * keep * (r > 0.9975 ? 1.0 : uVis);
  float size = (0.8 + 2.1 * r * r) * (1.0 - 0.45 * o) * (uResolution.y / 1080.0);
  gl_PointSize = keep > 0.5 ? size : 0.0;
  gl_Position = vec4(p.x / aspect, p.y, 0.0, 1.0);
}
