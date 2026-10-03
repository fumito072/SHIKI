// SHIKI FX: feedback
uniform sampler2D uTex;
uniform sampler2D uHistory;
uniform float uDecay;
varying vec2 vUv;
void main() {
  vec3 current = texture2D(uTex, vUv).rgb;
  vec3 history = texture2D(uHistory, vUv).rgb;
  gl_FragColor = vec4(mix(current, history, uDecay), 1.0);
}
