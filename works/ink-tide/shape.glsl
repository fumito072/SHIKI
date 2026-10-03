float inkSquare(float x) { return x * x; }

vec2 inkTurn(vec2 p, vec2 centre, float radius, float angle) {
  vec2 d = p - centre;
  float a = angle * exp(-dot(d, d) / (radius * radius));
  return centre + mat2(cos(a), -sin(a), sin(a), cos(a)) * d;
}

float inkRibbon(vec2 p, vec2 centre, float width) {
  vec2 d = p - centre;
  return exp(-d.y * d.y / (width * width) - d.x * d.x / 0.25);
}

float initialInk(vec2 p, float aspect) {
  vec2 q = inkTurn(p, vec2(aspect * 0.8, 0.76), 0.4, 3.2);
  q = inkTurn(q, vec2(aspect * 0.83, 0.29), 0.36, -2.7);
  q = inkTurn(q, vec2(aspect * 0.58, 0.24), 0.23, 1.2);
  q.y += 0.036 * sin(q.x * 7.0) + 0.008 * sin(q.x * 23.0);
  float d = inkRibbon(q, vec2(aspect * 0.8, 0.76), 0.053);
  d += 0.85 * inkRibbon(q, vec2(aspect * 0.82, 0.32), 0.042);
  d += 0.52 * inkRibbon(q, vec2(aspect * 0.64, 0.19), 0.025);
  return d * smoothstep(0.39, 0.54, p.x / aspect);
}

float suspendedDrop(vec2 p, float aspect) {
  vec2 d = (p - inkAttractor(aspect)) / vec2(0.049, 0.063);
  return 1.35 * (1.0 - smoothstep(0.65, 1.0, length(d)));
}
