// MOONSEA — the sea under a harsh moon. Ripples that arrive before the beat, a reflection one bar late,
// a sea that climbs toward the moon and floods the sky on the drop. Linear HDR.
varying vec2 vUv;

vec3 rimColor() {
  return mix(srgb(vec3(0.78, 0.82, 0.84)), srgb(vec3(0.62, 0.86, 0.90)), 0.35);
}

// Everything above the water for a moon at m.
vec3 sky(vec2 p, vec2 m) {
  float skyT = smoothstep(HORIZON, 1.1, p.y);
  vec3 col = mix(srgb(vec3(0.075, 0.085, 0.095)), srgb(vec3(0.018, 0.021, 0.026)), skyT);

  float R = 0.66;
  vec2 q = (p - m) / R;
  float r = length(q);
  float pulse = (1.0 + 0.6 * uLow) * (1.0 + 0.9 * uTide);

  float halo = exp(-max(r - 1.0, 0.0) * 5.0) * smoothstep(0.92, 1.02, r);
  halo += exp(-max(r - 1.0, 0.0) * 1.6) * 0.18;
  col += rimColor() * halo * (0.05 + 0.35 * M_HALO) * pulse;

  if (r < 1.0) {
    vec3 n = vec3(q, sqrt(max(1.0 - r * r, 0.0)));
    float rim = pow(1.0 - n.z, 3.5);
    float surface = fbm(vec3(q * 3.2, 1.7)) * 0.5 + 0.5;
    vec3 body = srgb(vec3(0.030, 0.034, 0.040)) * (0.7 + 0.6 * surface);
    float lit = max(dot(n, normalize(vec3(-0.55, 0.45, 0.35))), 0.0);
    body += srgb(vec3(0.20, 0.22, 0.24)) * pow(lit, 6.0) * 0.08;
    body += rimColor() * rim * (0.18 + 0.7 * M_HALO) * pulse;
    col = mix(col, body, smoothstep(1.0, 0.985, r));
  }

  // Mist on the horizon; it stops moving as the tension builds (stillness before the break).
  float t = uMistClock;
  float mist = fbm(vec3(p.x * 0.9 - t, p.y * 3.2, t * 0.6)) * 0.5 + 0.5;
  float band = exp(-abs(p.y - HORIZON - 0.06) * 4.5);
  col += srgb(vec3(0.42, 0.47, 0.50)) * mist * mist * band * (0.02 + 0.16 * M_MIST);
  return col;
}

// Height of one ring at distance from its source.
float ring(vec2 w, vec2 src, float radius, float amp) {
  float x = length(w - src) - radius;
  return amp * sin(x * 30.0) * exp(-x * x / 0.012);
}

// This beat's and the last beat's rings expand; the next beat's rings converge on their source before it happens.
float ripples(vec2 w, vec2 m) {
  float n = floor(uBeats);
  float age = fract(uBeats);
  float a = 0.07 * (0.35 + M_ENERGY);
  float h = ring(w, rippleSource(n, m), 0.6 * age, a * exp(-age * 1.1));
  h += ring(w, rippleSource(n - 1.0, m), 0.6 * (age + 1.0), a * exp(-(age + 1.0) * 1.1));
  float omen = smoothstep(0.4, 0.97, age) * M_OMEN;
  h += ring(w, rippleSource(n + 1.0, m), 0.85 * (1.0 - age), 0.06 * omen);
  return h;
}

vec2 rippleNormal(vec2 w, vec2 m) {
  const float e = 0.008;
  float h = ripples(w, m);
  return vec2(ripples(w + vec2(e, 0.0), m) - h, ripples(w + vec2(0.0, e), m) - h) / e;
}

// The water line: a tidal bulge under the moon, and the flood on the drop.
float surfaceY(float x, vec2 m, float aspect) {
  float bulge = exp(-pow((x - m.x) / (0.28 * aspect), 2.0)) * 0.11 * uTide;
  // The flooded surface is not a ruler line: it heaves, higher under the moon.
  float swell = uFlood * (0.04 * snoise(vec3(x * 1.8, uWaterClock * 1.5, 1.0)) + 0.08 * exp(-pow((x - m.x) / aspect, 2.0)));
  return HORIZON + bulge + uFlood + swell;
}

void main() {
  float aspect = uResolution.x / uResolution.y;
  vec2 p = (vUv - 0.5) * vec2(aspect, 1.0) * 2.0;
  vec2 m = moonAt(uBeats, aspect);
  vec2 late = moonAt(uBeats - 4.0, aspect);
  float surf = surfaceY(p.x, m, aspect);
  vec3 col;

  if (p.y >= surf) {
    col = sky(p, m);
  } else if (p.y >= HORIZON) {
    // Water standing above the horizon (bulge or flood): we look at the sky through a wall of sea.
    float dz = surf - p.y;
    vec3 q = vec3(p * 3.0, uWaterClock * 0.7);
    vec2 n = vec2(snoise(q), snoise(q + 7.0));
    vec3 seen = sky(p + n * 0.03, m);
    vec3 absorb = exp(-vec3(2.4, 1.1, 0.9) * dz * 1.6);
    col = seen * absorb * 0.85 + srgb(vec3(0.02, 0.035, 0.04)) * (1.0 - absorb);
    float caustic = pow(max(snoise(vec3(p * 9.0, uWaterClock)), 0.0), 6.0);
    col += rimColor() * caustic * 0.05 * (1.0 - absorb.r);
    // The water line seen from the side: uneven, brightest where the moon lights it.
    float lit = 0.25 + 0.75 * exp(-abs(p.x - m.x) * 1.2);
    float rough = 0.6 + 0.4 * snoise(vec3(p.x * 6.0, uWaterClock * 2.0, 3.0));
    col += rimColor() * exp(-dz * 90.0) * (0.12 + 0.45 * uFlood) * lit * rough;
  } else {
    float depth = 1.0 / max(HORIZON - p.y, 0.002);
    vec2 w = vec2(p.x * depth * 0.6, depth);
    float t = uWaterClock;
    const float e = 0.15;
    float h0 = fbm(vec3(w.x * 0.7, w.y * 0.35 - t, t * 0.3));
    float hx = fbm(vec3((w.x + e) * 0.7, w.y * 0.35 - t, t * 0.3));
    float hy = fbm(vec3(w.x * 0.7, (w.y + e) * 0.35 - t, t * 0.3));
    vec2 n = vec2(hx - h0, hy - h0) / e * (1.0 - 0.6 * uTide);
    n += rippleNormal(w, m);
    float near = clamp((HORIZON - p.y) * 1.6, 0.0, 1.0);
    vec2 rp = vec2(p.x + n.x * 0.05 * (0.3 + near), 2.0 * HORIZON - p.y + n.y * 0.03 * (0.3 + near));
    float fresnel = mix(0.55, 0.12, near);
    // The reflection shows the moon where it was one bar ago.
    col = srgb(vec3(0.010, 0.012, 0.015)) + sky(rp, late) * fresnel;
    float g = snoise(vec3(w.x * 6.0, w.y * 2.2 - t * 3.0, t));
    col += rimColor() * pow(max(g, 0.0), 14.0) * (0.6 + 2.5 * uHigh) * (1.0 - near * 0.6) * 0.35;
  }

  gl_FragColor = vec4(col, 1.0);
}
