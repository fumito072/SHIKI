// INK TIDE: jacobi
uniform sampler2D uPressure;
uniform sampler2D uDivergence;
float pressure(vec2 uv) { return texture2D(uPressure, safeUv(uv)).r; }

void main() {
  vec2 ex = vec2(uTexel.x, 0.0), ey = vec2(0.0, uTexel.y);
  float dx = uTexel.y;
  float sum = pressure(vUv + ex) + pressure(vUv - ex) + pressure(vUv + ey) + pressure(vUv - ey);
  float pNext = (sum - texture2D(uDivergence, vUv).r * dx * dx) * 0.25;
  gl_FragColor = vec4(pNext, 0.0, 0.0, 1.0);
}
