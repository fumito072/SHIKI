// SHIKI transition: luma-wipe
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform float uProgress;
varying vec2 vUv;
void main() {
  vec4 incoming = texture2D(uTo, vUv);
  float luminance = max(0.0, dot(incoming.rgb, vec3(0.2126, 0.7152, 0.0722)));
  float threshold = 1.0 - luminance / (1.0 + luminance);
  float reveal = smoothstep(threshold - 0.06, threshold + 0.06, uProgress * 1.12 - 0.06);
  gl_FragColor = mix(texture2D(uFrom, vUv), incoming, reveal);
}
