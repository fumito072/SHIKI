// INK TIDE: normal
uniform sampler2D uDye;
uniform vec2 uTexel;
varying vec2 vUv;

float heightAt(vec2 uv) {
  float d = texture2D(uDye, clamp(uv, 0.5 * uTexel, 1.0 - 0.5 * uTexel)).r;
  return sqrt(max(0.0, d)) * smoothstep(0.025, 0.16, d);
}

void main() {
  vec2 ex = vec2(uTexel.x, 0.0), ey = vec2(0.0, uTexel.y);
  vec2 gradient = vec2(heightAt(vUv + ex) - heightAt(vUv - ex), heightAt(vUv + ey) - heightAt(vUv - ey)) / (2.0 * uTexel.y);
  float density = texture2D(uDye, vUv).r;
  gl_FragColor = vec4(gradient, smoothstep(0.04, 0.28, density), density);
}
