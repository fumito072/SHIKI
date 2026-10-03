// SHIKI FX: strobe
uniform sampler2D uTex;
uniform float uAmount;
uniform float uGate;
varying vec2 vUv;
void main() {
  // CPU gate enforces a minimum 125 ms between flashes, even across tempo jumps.
  gl_FragColor = vec4(texture2D(uTex, vUv).rgb * mix(1.0, uGate, uAmount), 1.0);
}
