// INK TIDE: divergence
uniform sampler2D uVelocity;
vec2 velocity(vec2 uv) {
  vec2 v = texture2D(uVelocity, safeUv(uv)).xy;
  if (uv.x < 0.0 || uv.x > 1.0) v.x = -v.x;
  if (uv.y < 0.0 || uv.y > 1.0) v.y = -v.y;
  return v;
}

void main() {
  vec2 ex = vec2(uTexel.x, 0.0), ey = vec2(0.0, uTexel.y);
  float dx = uTexel.y;
  float div = (velocity(vUv + ex).x - velocity(vUv - ex).x + velocity(vUv + ey).y - velocity(vUv - ey).y) / (2.0 * dx);
  gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
}
