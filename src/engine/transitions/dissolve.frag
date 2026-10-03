// SHIKI transition: dissolve
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform float uProgress;
varying vec2 vUv;
void main() {
  gl_FragColor = mix(texture2D(uFrom, vUv), texture2D(uTo, vUv), uProgress);
}
