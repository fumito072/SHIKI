// SHIKI FX: grain
uniform sampler2D uTex;
uniform float uAmount;
uniform float uTime;
uniform vec2 uResolution;
varying vec2 vUv;
#include <shiki_noise>
void main() {
  vec3 c = texture2D(uTex, vUv).rgb;
  float n = hash12(vUv * uResolution + floor(uTime * 24.0) * 17.13) - 0.5;
  gl_FragColor = vec4(max(c + n * uAmount * 0.06, 0.0), 1.0);
}
