// INK TIDE: dye
uniform sampler2D uVelocity;
uniform sampler2D uDye;
uniform sampler2D uSeed;
uniform float uDt;
uniform float uGather;
uniform float uBurst;
uniform float uFlood;
uniform float uBloom;
vec2 velocity(vec2 uv) {
  vec2 v = texture2D(uVelocity, safeUv(uv)).xy;
  if (uv.x < 0.0 || uv.x > 1.0) v.x = -v.x;
  if (uv.y < 0.0 || uv.y > 1.0) v.y = -v.y;
  return v;
}
vec4 dye(vec2 uv) {
  vec4 ink = texture2D(uDye, safeUv(uv));
  ink.r *= inkWall(uv, uTexel);
  return ink;
}

void main() {
  vec2 ex = vec2(uTexel.x, 0.0), ey = vec2(0.0, uTexel.y);
  vec2 p = vUv * vec2(uAspect, 1.0);
  // Ink thickness can gather on an incompressible carrier surface.
  vec2 attractor = inkAttractor(uAspect);
  vec2 squeeze = vec2(1.4, 0.7) * uGather * uDt * 0.95;
  vec2 back = toUv(attractor + (p - attractor) * exp(squeeze)) - toUv(velocity(vUv)) * uDt;
  vec4 advected = dye(back);
  vec2 forward = toUv(attractor + (back * vec2(uAspect, 1.0)
    + velocity(back) * uDt - attractor) * exp(-squeeze));
  vec4 corrected = advected + 0.5 * (dye(vUv) - dye(forward));
  vec2 cell = (floor(back / uTexel - 0.5) + 0.5) * uTexel;
  vec4 a = dye(cell), b = dye(cell + ex), c = dye(cell + ey), d = dye(cell + ex + ey);
  corrected = clamp(corrected, min(min(a, b), min(c, d)), max(max(a, b), max(c, d)));
  float density = corrected.r * exp(squeeze.x + squeeze.y - uDt * 0.009);
  float outside = 1.0 - smoothstep(0.36, 0.46, vUv.x);
  density *= exp(-uDt * outside * (1.0 - uFlood) * (1.0 + 4.0 * M_CALM));
  // Keep narrow interfaces; do not turn advected filaments into fog.
  density += uDt * 0.18 * density * (density - 0.22) * (1.0 - min(density, 1.0));
  float refill = 1.0 - exp(-uDt * (0.012 * (1.0 - uGather) * (1.0 - uFlood) + 2.4 * uBloom));
  float seed = texture2D(uSeed, vUv).r;
  density += refill * max(0.0, seed - density);
  float jetY = attractor.y - 0.18 * sin(clamp((attractor.x - p.x) * 3.0, 0.0, 3.14));
  float stream = exp(-inkSquare((p.y - jetY) / (0.011 + 0.009 * M_STRETCH)));
  stream *= smoothstep(0.1, 0.23, vUv.x) * (1.0 - smoothstep(0.71, 0.74, vUv.x));
  float injection = stream * uBurst * uDt * 3.5;
  // Store displacement: absolute half-float UVs lose subpixel motion.
  vec2 material = advected.gb + (safeUv(back) - vUv);
  material *= 1.0 - clamp(injection + refill * seed, 0.0, 1.0);
  material = safeUv(vUv + material) - vUv;
  gl_FragColor = vec4(clamp(density + injection, 0.0, 3.0) * inkWall(vUv, uTexel), material, 1.0);
}
