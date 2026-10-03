#include <shiki_noise>

varying vec2 vUv;

vec2 turn(vec2 p, vec2 centre, float radius, float angle) {
  vec2 d = p - centre;
  float a = angle * exp(-dot(d, d) / (radius * radius));
  float s = sin(a), c = cos(a);
  return centre + mat2(c, -s, s, c) * d;
}

float ribbon(vec2 p, vec2 emitter, float width) {
  vec2 d = p - emitter;
  return exp(-d.y * d.y / (width * width) - d.x * d.x / 0.48);
}

void main() {
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = vec2(vUv.x * aspect, vUv.y);
  float t = uTime * 0.025;
  float bass = smoothstep(0.0, 1.0, uLow);
  float kick = smoothstep(0.0, 1.0, uKick);
  // Bass enlarges a bounded tide; it never multiplies the absolute time.
  float tide = (0.014 + 0.022 * M_FLOW + 0.009 * bass) * sin(t * 0.83);
  vec2 upper = vec2(aspect * (0.79 + 0.017 * sin(t * 0.71)), 0.73 + tide);
  vec2 lower = vec2(aspect * (0.82 + 0.014 * cos(t * 0.59)), 0.29 - tide);
  vec2 inlet = vec2(aspect * 0.56, 0.26 + 0.02 * sin(t * 0.61));

  vec2 q = turn(p, upper, 0.43, 1.45 + 2.4 * M_SWIRL + 0.16 * sin(t));
  q = turn(q, lower, 0.35, -1.3 - 2.0 * M_SWIRL + 0.12 * cos(t * 0.7));
  q = turn(q, inlet, 0.27, 0.5 + 0.9 * M_SWIRL);
  vec2 current = curl2(q * 2.7 + vec2(4.7, 1.9), t * 0.19);
  q += current * (0.014 + 0.013 * M_FLOW + 0.002 * kick);
  q += 0.011 * curl2(q * 6.8 + vec2(8.2, -2.4), t * 0.13);
  q.y += 0.055 * sin(q.x * 4.7 + t * 0.37);
  q.x += (0.022 + 0.075 * M_FLOW) * sin(t * 0.77);
  q.y += 0.011 * sin(t * 0.62);

  float width = mix(0.035, 0.082, M_DENSITY);
  float dye = ribbon(q, vec2(aspect * 0.77, 0.73), width);
  dye += 0.75 * ribbon(q, vec2(aspect * 0.8, 0.34), width * 0.82);
  dye += 0.42 * ribbon(q, vec2(aspect * 0.61, 0.2), width * 0.72);
  dye *= 0.75 + 0.25 * snoise(vec3(q * 9.0, t * 0.11));
  dye += 0.035 * smoothstep(0.42, 0.8, vUv.x);
  dye *= 1.0 + 0.22 * kick;
  float warm = exp(-dot((p - upper) * vec2(1.0, 1.5), (p - upper) * vec2(1.0, 1.5)) / 0.035);
  // Store displacement for better half-float precision at the dark margins.
  gl_FragColor = vec4(q - p, dye, warm);
}
