// SHIKI FX: rgb-split
uniform sampler2D uTex;
uniform float uAmount;
uniform float uBeat;
uniform vec2 uResolution;
varying vec2 vUv;
void main() {
  float pulse = exp(-uBeat * 8.0);
  vec2 offset = vec2(14.0, 3.0) / uResolution * uAmount * pulse;
  vec3 c;
  c.r = texture2D(uTex, clamp(vUv + offset, 0.0, 1.0)).r;
  c.g = texture2D(uTex, vUv).g;
  c.b = texture2D(uTex, clamp(vUv - offset, 0.0, 1.0)).b;
  gl_FragColor = vec4(c, 1.0);
}
