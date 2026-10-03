// SHIKI transition: cut
uniform sampler2D uFrom;
uniform sampler2D uTo;
uniform float uProgress;
varying vec2 vUv;
void main() {
  gl_FragColor = uProgress < 1.0 ? texture2D(uFrom, vUv) : texture2D(uTo, vUv);
}
