// MOONSEA — long-exposure trails: keep the brighter of now and the fading past.
uniform sampler2D uCurrent;
uniform sampler2D uPrev;
varying vec2 vUv;

void main() {
  vec3 now = texture2D(uCurrent, vUv).rgb;
  vec3 past = texture2D(uPrev, vUv).rgb;
  float keep = mix(0.0, 0.93, M_TRAILS);
  gl_FragColor = vec4(max(now, past * keep), 1.0);
}
