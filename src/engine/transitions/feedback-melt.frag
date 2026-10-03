// SHIKI transition: feedback-melt
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform sampler2D uHistory;
uniform float uProgress;
uniform float uTime;
uniform float uDt;
uniform float uDecay;
varying vec2 vUv;
void main() {
  float bend = sin(vUv.x * 19.0 + uTime * 0.37) * sin(vUv.y * 11.0 - uTime * 0.21);
  vec2 drift = vec2(bend * 0.018, -(0.012 + 0.018 * bend)) * uDt * uProgress;
  vec3 history = texture2D(uHistory, clamp(vUv - drift, 0.0, 1.0)).rgb;
  vec3 outgoing = texture2D(uFrom, vUv).rgb;
  vec3 melting = mix(outgoing, history, uDecay * smoothstep(0.0, 0.12, uProgress));
  gl_FragColor = vec4(mix(melting, texture2D(uTo, vUv).rgb, uProgress), 1.0);
}
