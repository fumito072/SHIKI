// INK TIDE: advect
uniform sampler2D uVelocity;
uniform sampler2D uDye;
uniform float uDt;
uniform float uStroke;
uniform float uArc;
uniform float uGather;
uniform float uSlowLow;
uniform float uBurst;
vec2 velocity(vec2 uv) {
  vec2 v = texture2D(uVelocity, safeUv(uv)).xy;
  if (uv.x < 0.0 || uv.x > 1.0) v.x = -v.x;
  if (uv.y < 0.0 || uv.y > 1.0) v.y = -v.y;
  return v;
}
vec4 dye(vec2 uv) { return texture2D(uDye, safeUv(uv)); }

void main() {
  vec2 ex = vec2(uTexel.x, 0.0), ey = vec2(0.0, uTexel.y);
  vec2 p = vUv * vec2(uAspect, 1.0);
  vec2 back = safeUv(vUv - toUv(velocity(vUv)) * uDt);
  vec2 v = velocity(back);
  vec2 average = 0.25 * (velocity(back + ex) + velocity(back - ex) + velocity(back + ey) + velocity(back - ey));
  // Stable bounded diffusion, followed by viscous drag.
  float viscosity = clamp(M_VISCOSITY + uSlowLow * 0.12, 0.0, 1.0);
  v = mix(v, average, min(0.24, uDt * (3.0 + 11.0 * viscosity)));
  v *= exp(-uDt * (2.0 + 5.5 * viscosity));
  vec2 centre = vec2(uAspect * (0.76 + 0.04 * sin(uArc * 2.1)), 0.58 + 0.15 * cos(uArc * 2.0));
  vec2 d = p - centre;
  float radius = length(d);
  vec2 tangent = vec2(-d.y, d.x) / max(radius, 0.03);
  float arc = exp(-inkSquare((radius - 0.23) / 0.095));
  arc *= smoothstep(-0.28, 0.06, d.x + 0.45 * d.y);
  vec2 force = (tangent + d * 0.55) * arc * uStroke * (1.6 + 3.4 * M_ENERGY) * (0.3 + 1.7 * M_STRETCH);
  vec2 attractor = inkAttractor(uAspect);
  vec2 toDrop = attractor - p;
  float body = smoothstep(0.03, 0.55, dye(vUv).r);
  force += uGather * body * toDrop * vec2(2.0, 2.5);
  // A bent jet opens the previously forbidden left side.
  float jetY = attractor.y - 0.18 * sin(clamp((attractor.x - p.x) * 3.0, 0.0, 3.14));
  float jet = exp(-inkSquare((p.y - jetY) / 0.11));
  jet *= exp(-inkSquare(inkSquare((p.x - uAspect * 0.57) / (uAspect * 0.38))));
  force += uBurst * jet * vec2(-12.0, -3.6 * cos((attractor.x - p.x) * 3.0));
  // Slow solenoidal flow survives pressure projection and viscous drag.
  vec2 drift = vec2(-0.05 + 0.022 * cos(p.y * 5.0 - uTime * 0.14),
  0.055 * sin(p.x * 5.0 + uTime * 0.12));
  drift *= (1.0 - uGather) * (1.0 - 0.7 * M_CALM);
  v += uDt * (force + drift);
  gl_FragColor = vec4(wallVelocity(v, vUv), 0.0, 1.0);
}
