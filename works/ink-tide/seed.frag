uniform float uAspect;
uniform float uSeedKind;
uniform vec2 uTexel;
varying vec2 vUv;

void main() {
  if (uSeedKind < 0.5) { gl_FragColor = vec4(0.0); return; }
  vec2 p = vec2(vUv.x * uAspect, vUv.y);
  float d = uSeedKind > 1.5 ? suspendedDrop(p, uAspect) : initialInk(p, uAspect);
  gl_FragColor = vec4(d * inkWall(vUv, uTexel), 0.0, 0.0, 1.0);
}
