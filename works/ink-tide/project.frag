// INK TIDE: project
uniform sampler2D uVelocity;
uniform sampler2D uPressure;
vec2 velocity(vec2 uv) {
  vec2 v = texture2D(uVelocity, safeUv(uv)).xy;
  if (uv.x < 0.0 || uv.x > 1.0) v.x = -v.x;
  if (uv.y < 0.0 || uv.y > 1.0) v.y = -v.y;
  return v;
}
float pressure(vec2 uv) { return texture2D(uPressure, safeUv(uv)).r; }

void main() {
  vec2 ex = vec2(uTexel.x, 0.0), ey = vec2(0.0, uTexel.y);
  float dx = uTexel.y;
  vec2 grad = vec2(pressure(vUv + ex) - pressure(vUv - ex), pressure(vUv + ey) - pressure(vUv - ey)) / (2.0 * dx);
  vec2 v = velocity(vUv) - grad;
  // Projection can increase speed too; enforce the bound after it.
  gl_FragColor = vec4(wallVelocity(v, vUv), 0.0, 1.0);
}
