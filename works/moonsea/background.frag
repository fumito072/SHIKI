// MOONSEA — night sea, a dark sphere rising behind the horizon, mist. Linear HDR.
varying vec2 vUv;

#include <shiki_noise>
#include <shiki_color>

const float HORIZON = -0.30;

vec3 rimColor() {
  return mix(srgb(vec3(0.78, 0.82, 0.84)), srgb(vec3(0.62, 0.86, 0.90)), M_TINT);
}

// Everything above the water: sky, sphere, halo, mist.
vec3 above(vec2 p, float aspect) {
  float skyT = smoothstep(HORIZON, 1.1, p.y);
  vec3 col = mix(srgb(vec3(0.075, 0.085, 0.095)), srgb(vec3(0.018, 0.021, 0.026)), skyT);

  // Sphere: right of centre, partly below the horizon.
  vec2 c = vec2(0.38 * aspect, 0.20);
  float R = 0.66;
  vec2 q = (p - c) / R;
  float r = length(q);
  float lowPulse = 1.0 + 0.6 * uLow;

  // Corona behind the limb.
  float halo = exp(-max(r - 1.0, 0.0) * 5.0) * smoothstep(0.92, 1.02, r);
  halo += exp(-max(r - 1.0, 0.0) * 1.6) * 0.18;
  col += rimColor() * halo * (0.05 + 0.35 * M_HALO) * lowPulse;

  if (r < 1.0) {
    vec3 n = vec3(q, sqrt(max(1.0 - r * r, 0.0)));
    float rim = pow(1.0 - n.z, 3.5);
    float surface = fbm(vec3(q * 3.2, 1.7)) * 0.5 + 0.5;
    vec3 body = srgb(vec3(0.030, 0.034, 0.040)) * (0.7 + 0.6 * surface);
    float lit = max(dot(n, normalize(vec3(-0.55, 0.45, 0.35))), 0.0);
    body += srgb(vec3(0.20, 0.22, 0.24)) * pow(lit, 6.0) * 0.08;
    body += rimColor() * rim * (0.18 + 0.7 * M_HALO) * lowPulse;
    float edge = smoothstep(1.0, 0.985, r);
    col = mix(col, body, edge);
  }

  // Mist hugging the horizon, drifting slowly.
  float t = uTime * (0.012 + 0.03 * M_DRIFT);
  float m = fbm(vec3(p.x * 0.9 - t, p.y * 3.2, t * 0.6)) * 0.5 + 0.5;
  float band = exp(-abs(p.y - HORIZON - 0.06) * 4.5);
  col += srgb(vec3(0.42, 0.47, 0.50)) * m * m * band * (0.02 + 0.16 * M_MIST);
  return col;
}

void main() {
  float aspect = uResolution.x / uResolution.y;
  vec2 p = (vUv - 0.5) * vec2(aspect, 1.0) * 2.0;
  vec3 col;

  if (p.y > HORIZON) {
    col = above(p, aspect);
  } else {
    // Water: perspective coordinates, wave normal from noise, mirrored sky.
    float depth = 1.0 / max(HORIZON - p.y, 0.002);
    vec2 w = vec2(p.x * depth * 0.6, depth);
    float t = uTime * (0.08 + 0.2 * M_DRIFT);
    float e = 0.15;
    float h0 = fbm(vec3(w.x * 0.7, w.y * 0.35 - t, t * 0.3));
    float hx = fbm(vec3((w.x + e) * 0.7, w.y * 0.35 - t, t * 0.3));
    float hy = fbm(vec3(w.x * 0.7, (w.y + e) * 0.35 - t, t * 0.3));
    vec2 n = vec2(hx - h0, hy - h0) / e;
    float near = clamp((HORIZON - p.y) * 1.6, 0.0, 1.0);
    vec2 rp = vec2(p.x + n.x * 0.05 * (0.3 + near), 2.0 * HORIZON - p.y + n.y * 0.03 * (0.3 + near));
    float fresnel = mix(0.55, 0.12, near);
    col = srgb(vec3(0.010, 0.012, 0.015)) + above(rp, aspect) * fresnel;

    // Glints catching the corona, sharper with the highs.
    float g = snoise(vec3(w.x * 6.0, w.y * 2.2 - t * 3.0, t));
    float glint = pow(max(g, 0.0), 14.0) * (0.6 + 2.5 * uHigh) * (1.0 - near * 0.6);
    col += rimColor() * glint * 0.35;
  }

  gl_FragColor = vec4(col, 1.0);
}
