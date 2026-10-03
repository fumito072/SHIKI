// INK TIDE: ink
#include <shiki_noise>
#include <shiki_color>

uniform sampler2D uDye;
uniform sampler2D uSurface;
uniform float uFlood;
uniform float uAspect;
varying vec2 vUv;

vec3 background(vec2 uv) {
  vec3 black = srgb(vec3(5.0, 7.0, 12.0) / 255.0);
  vec3 deep = srgb(vec3(18.0, 35.0, 58.0) / 255.0);
  float haze = exp(-dot((uv - vec2(0.83, 0.65)) * vec2(1.1, 0.8), (uv - vec2(0.83, 0.65)) * vec2(1.1, 0.8)) * 5.0);
  return black + deep * haze * 0.07;
}

void main() {
  vec4 ink = texture2D(uDye, vUv);
  vec4 surface = texture2D(uSurface, vUv);
  float density = ink.r;
  float body = surface.b;
  vec2 gradient = surface.rg;
  vec3 normal = normalize(vec3(-gradient * (0.025 + 0.035 * M_GLOSS), 1.0));
  vec3 halfLight = normalize(vec3(-0.62, 0.78, 1.6));
  float specular = pow(max(0.0, dot(normal, halfLight)), mix(45.0, 145.0, M_GLOSS));
  vec3 reflection = reflect(vec3(0.0, 0.0, -1.0), normal);
  float strip = exp(-inkSquare((reflection.y - 0.44 - reflection.x * 0.32) / 0.052));
  float rim = pow(1.0 - normal.z, 2.0);
  vec3 base = background(vUv);
  vec2 bend = normal.xy * 0.015 * body / vec2(uAspect, 1.0);
  vec2 hazeOffset = (vUv - vec2(0.83, 0.65)) * vec2(1.1, 0.8);
  float refraction = clamp(1.0 - 10.0 * dot(hazeOffset, bend * vec2(1.1, 0.8)), 0.9, 1.1);
  vec3 color = base * refraction;
  color *= 1.0 - body * 0.55;
  vec3 silver = srgb(vec3(207.0, 214.0, 220.0) / 255.0);
  vec3 blue = srgb(vec3(76.0, 106.0, 134.0) / 255.0);
  vec3 gold = srgb(vec3(227.0, 196.0, 155.0) / 255.0);
  vec2 q = (vUv + ink.gb) * vec2(uAspect, 1.0);
  float phase = q.y * 550.0 + 1.7 * sin(q.x * 55.0);
  float aa = max(fwidth(phase), 0.03);
  float fiber = (1.0 - smoothstep(0.045, 0.045 + aa, abs(fract(phase) - 0.5))) * min(1.0, 0.38 / aa);
  float grain = hash12(floor(q * vec2(890.0, 1350.0)));
  float dust = smoothstep(0.68, 0.98, grain);
  float warm = exp(-dot((vUv - vec2(0.8, 0.82)) * vec2(uAspect, 1.4), (vUv - vec2(0.8, 0.82)) * vec2(uAspect, 1.4)) / 0.024);
  vec3 sheen = mix(silver, gold, warm * M_WARMTH * 0.85);
  float glints = smoothstep(0.93, 0.995, grain) * uHigh * (strip + specular);
  color += blue * body * 0.012;
  color += sheen * body * (specular * 1.65 + strip * 0.43 + rim * 0.18) * (0.25 + 1.6 * M_GLOSS);
  color += mix(blue, sheen, dust) * density * (fiber * (0.12 + 0.7 * dust) + 0.02 * dust) * 0.7;
  color += silver * glints * body * 0.3;
  float quietLeft = smoothstep(mix(0.27, 0.37, M_CALM), 0.48, vUv.x);
  color = mix(base, color, mix(quietLeft, 1.0, uFlood));
  gl_FragColor = vec4(color, 1.0);
}
