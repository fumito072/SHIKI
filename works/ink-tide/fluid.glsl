uniform vec2 uTexel;
uniform float uAspect;
varying vec2 vUv;

vec2 safeUv(vec2 uv) { return inkSafeUv(uv, uTexel); }
vec2 toUv(vec2 p) { return p / vec2(uAspect, 1.0); }

vec2 wallVelocity(vec2 v, vec2 uv) {
  v *= min(1.0, 1.8 / max(length(v), 0.001));
  // Free slip: damp the normal component, preserve tangential flow.
  vec2 fade = smoothstep(uTexel * 0.5, max(uTexel * 2.0, vec2(0.015)), uv)
    * smoothstep(uTexel * 0.5, max(uTexel * 2.0, vec2(0.015)), 1.0 - uv);
  return v * fade;
}

float inkSquare(float x) { return x * x; }
