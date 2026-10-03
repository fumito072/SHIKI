// INK TIDE: replay
uniform sampler2D uDye;
uniform sampler2D uHistoryA;
uniform sampler2D uHistoryB;
uniform float uHistoryMix;
uniform float uReplay;
uniform float uCollapse;
uniform vec2 uTexel;
uniform float uAspect;
varying vec2 vUv;

vec4 material(vec2 uv) {
  if (uReplay < 0.0) return texture2D(uDye, clamp(uv, 0.5 * uTexel, 1.0 - 0.5 * uTexel));
  vec2 centre = inkAttractor(uAspect) / vec2(uAspect, 1.0);
  float c = smoothstep(0.0, 1.0, uCollapse);
  float scale = mix(1.0, 0.055, c);
  vec2 source = centre + (uv - centre) / scale;
  vec4 ink = mix(texture2D(uHistoryA, inkSafeUv(source, uTexel)), texture2D(uHistoryB, inkSafeUv(source, uTexel)), uHistoryMix);
  float inside = inkWall(source, uTexel);
  ink.r *= inside * mix(1.0, 2.4, c);
  ink.r = mix(ink.r, suspendedDrop(uv * vec2(uAspect, 1.0), uAspect), smoothstep(0.65, 1.0, c));
  ink.gb = mix(ink.gb + source - uv, vec2(0.0), smoothstep(0.65, 1.0, c));
  ink.gb = inkSafeUv(uv + ink.gb, uTexel) - uv;
  ink.r = clamp(ink.r, 0.0, 3.0) * inkWall(uv, uTexel);
  return ink;
}

void main() { gl_FragColor = material(vUv); }
