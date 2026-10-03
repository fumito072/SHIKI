// Finishing pass shared by every work: exposure -> ACES -> vignette -> sRGB -> grain/dither.
uniform sampler2D uTex;
uniform vec2 uResolution;
uniform float uTime;
uniform float uExposure;
uniform float uVignette;
uniform float uGrain;
varying vec2 vUv;

#include <shiki_noise>
#include <shiki_color>

void main() {
  vec3 c = texture2D(uTex, vUv).rgb * uExposure;
  c = aces(max(c, 0.0));

  vec2 q = vUv - 0.5;
  q.x *= uResolution.x / uResolution.y;
  c *= mix(1.0, smoothstep(1.15, 0.25, length(q)), uVignette);

  c = pow(c, vec3(1.0 / 2.2));

  float n = hash12(vUv * uResolution + fract(uTime * 7.31) * 517.0) - 0.5;
  c += n * uGrain + n * (1.5 / 255.0);

  gl_FragColor = vec4(c, 1.0);
}
