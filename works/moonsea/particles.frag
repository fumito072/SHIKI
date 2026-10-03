// MOONSEA — soft round particle, additive, linear HDR.
varying float vBright;
varying float vWarm;

#include <shiki_color>

void main() {
  vec2 p = gl_PointCoord - 0.5;
  float a = smoothstep(0.5, 0.05, length(p));
  vec3 cool = mix(srgb(vec3(0.80, 0.83, 0.85)), srgb(vec3(0.70, 0.90, 0.94)), M_TINT);
  vec3 col = mix(cool, srgb(vec3(0.89, 0.77, 0.61)), vWarm * 0.6);
  gl_FragColor = vec4(col * vBright * a * 0.22, 1.0);
}
