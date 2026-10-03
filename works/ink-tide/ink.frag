#include <shiki_noise>
#include <shiki_color>

uniform sampler2D uField;
uniform vec2 uFieldSize;
varying vec2 vUv;

float inkNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0)), f.x), f.y);
}

float threads(vec2 p, float frequency) {
  float phase = p.y * frequency + 3.5 * inkNoise(p * vec2(24.0, 53.0));
  float dist = abs(fract(phase) - 0.5);
  float aa = max(fwidth(phase), 0.035);
  float line = 1.0 - smoothstep(0.035, 0.035 + aa, dist);
  return line * min(1.0, 0.42 / aa);
}

void main() {
  vec2 sampleUv = clamp(vUv, 0.5 / uFieldSize, 1.0 - 0.5 / uFieldSize);
  vec4 field = texture2D(uField, sampleUv);
  float aspect = uResolution.x / max(uResolution.y, 1.0);
  vec2 p = vec2(vUv.x * aspect, vUv.y);
  vec2 q = p + field.xy;
  float t = uTime * 0.025;
  float high = smoothstep(0.0, 1.0, uHigh);
  float kick = smoothstep(0.0, 1.0, uKick);
  float left = smoothstep(mix(0.23, 0.38, M_CALM), mix(0.47, 0.59, M_CALM), vUv.x);
  float dye = max(field.z, 0.0) * left;

  q.y += 0.0025 * (inkNoise(q * vec2(37.0, 81.0)) - 0.5);
  float fine = mix(280.0, 720.0, M_DETAIL);
  float filament = threads(q, fine);
  filament += 0.45 * threads(q + vec2(3.7, 0.17), fine * 0.61);
  float grain = inkNoise(q * vec2(780.0, 1250.0) + vec2(-t * 0.38, 0.0));
  float after = inkNoise(q * vec2(780.0, 1250.0) + vec2(-t * 0.38 - 0.85, 0.0));
  float exposure = mix(grain, max(grain, after) * 0.85, M_TRAILS);
  float dots = smoothstep(0.56, 0.9, exposure);
  float glint = smoothstep(0.82, 0.98, grain) * high;
  float fibers = filament * (0.22 + 2.2 * dots + 0.65 * glint);
  float loose = smoothstep(0.74, 0.97, grain) * 0.07;
  float density = dye * (fibers + loose) * mix(0.65, 1.65, M_DENSITY);
  density *= 0.65 + 1.1 * M_ENERGY + 0.12 * kick;

  vec3 black = srgb(vec3(5.0, 7.0, 12.0) / 255.0);
  vec3 deep = srgb(vec3(18.0, 35.0, 58.0) / 255.0);
  vec3 blue = srgb(vec3(76.0, 106.0, 134.0) / 255.0);
  vec3 white = srgb(vec3(207.0, 214.0, 220.0) / 255.0);
  vec3 gold = srgb(vec3(227.0, 196.0, 155.0) / 255.0);
  float warm = field.w * smoothstep(0.06, 0.4, density) * M_WARMTH;
  vec3 ink = mix(blue, white, smoothstep(0.025, 0.36, density));
  ink = mix(ink, gold, min(0.65, warm * 2.0));
  float haze = dye * (0.028 + 0.032 * M_TRAILS);
  vec3 color = black + deep * haze + blue * dye * 0.006;
  color += ink * density * 2.6;
  gl_FragColor = vec4(color, 1.0);
}
