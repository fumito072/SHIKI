import { ShaderChunk, Vector2 } from 'three';
import type { Frame, InstrumentManifest } from './types';
import { MAX_MACROS } from './types';

export const FULLSCREEN_VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

const STD_UNIFORMS_GLSL = /* glsl */ `
uniform float uTime;
uniform vec2  uResolution;
uniform float uFrame;
uniform float uBpm;
uniform float uBeat;
uniform float uBar;
uniform float uBeats;
uniform float uLow;
uniform float uMid;
uniform float uHigh;
uniform float uLevel;
uniform float uOnset;
uniform float uKick;
uniform float uTension;
uniform float uDrop;
uniform float uMacro[${MAX_MACROS}];
`;

// Simplex noise: Ian McEwan, Ashima Arts (MIT). Hashes: Dave Hoskins "hash without sine" (MIT).
const NOISE_GLSL = /* glsl */ `
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 snoise_mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 snoise_mod289(vec4 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec4 snoise_permute(vec4 x) { return snoise_mod289(((x * 34.0) + 10.0) * x); }
vec4 snoise_tis(vec4 r) { return 1.79284291400159 - 0.85373472095314 * r; }
float snoise(vec3 v) {
  const vec2 C = vec2(1.0 / 6.0, 1.0 / 3.0);
  const vec4 D = vec4(0.0, 0.5, 1.0, 2.0);
  vec3 i = floor(v + dot(v, C.yyy));
  vec3 x0 = v - i + dot(i, C.xxx);
  vec3 g = step(x0.yzx, x0.xyz);
  vec3 l = 1.0 - g;
  vec3 i1 = min(g.xyz, l.zxy);
  vec3 i2 = max(g.xyz, l.zxy);
  vec3 x1 = x0 - i1 + C.xxx;
  vec3 x2 = x0 - i2 + C.yyy;
  vec3 x3 = x0 - D.yyy;
  i = snoise_mod289(i);
  vec4 p = snoise_permute(snoise_permute(snoise_permute(
      i.z + vec4(0.0, i1.z, i2.z, 1.0))
    + i.y + vec4(0.0, i1.y, i2.y, 1.0))
    + i.x + vec4(0.0, i1.x, i2.x, 1.0));
  float n_ = 0.142857142857;
  vec3 ns = n_ * D.wyz - D.xzx;
  vec4 j = p - 49.0 * floor(p * ns.z * ns.z);
  vec4 x_ = floor(j * ns.z);
  vec4 y_ = floor(j - 7.0 * x_);
  vec4 x = x_ * ns.x + ns.yyyy;
  vec4 y = y_ * ns.x + ns.yyyy;
  vec4 h = 1.0 - abs(x) - abs(y);
  vec4 b0 = vec4(x.xy, y.xy);
  vec4 b1 = vec4(x.zw, y.zw);
  vec4 s0 = floor(b0) * 2.0 + 1.0;
  vec4 s1 = floor(b1) * 2.0 + 1.0;
  vec4 sh = -step(h, vec4(0.0));
  vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy;
  vec4 a1 = b1.xzyw + s1.xzyw * sh.zzww;
  vec3 p0 = vec3(a0.xy, h.x);
  vec3 p1 = vec3(a0.zw, h.y);
  vec3 p2 = vec3(a1.xy, h.z);
  vec3 p3 = vec3(a1.zw, h.w);
  vec4 norm = snoise_tis(vec4(dot(p0, p0), dot(p1, p1), dot(p2, p2), dot(p3, p3)));
  p0 *= norm.x; p1 *= norm.y; p2 *= norm.z; p3 *= norm.w;
  vec4 m = max(0.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.0);
  m = m * m;
  return 42.0 * dot(m * m, vec4(dot(p0, x0), dot(p1, x1), dot(p2, x2), dot(p3, x3)));
}
float fbm(vec3 p) {
  float a = 0.5, s = 0.0;
  for (int i = 0; i < 5; i++) { s += a * snoise(p); p = p * 2.03 + vec3(17.1, -3.7, 9.2); a *= 0.5; }
  return s;
}
vec2 curl2(vec2 p, float t) {
  const float e = 0.01;
  float a = snoise(vec3(p + vec2(0.0, e), t));
  float b = snoise(vec3(p - vec2(0.0, e), t));
  float c = snoise(vec3(p + vec2(e, 0.0), t));
  float d = snoise(vec3(p - vec2(e, 0.0), t));
  return vec2(a - b, -(c - d)) / (2.0 * e);
}
`;

const COLOR_GLSL = /* glsl */ `
vec3 srgb(vec3 c) { return pow(c, vec3(2.2)); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
vec3 aces(vec3 x) {
  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);
}
`;

const chunks = ShaderChunk as unknown as Record<string, string>;
chunks['shiki_noise'] = NOISE_GLSL;
chunks['shiki_color'] = COLOR_GLSL;

export function macroDefines(manifest: InstrumentManifest): string {
  return manifest.macros
    .map((m, i) => `#define M_${m.id.toUpperCase()} uMacro[${i}]`)
    .join('\n');
}

/** Standard uniform declarations + macro defines. Prepend to every fragment/vertex shader of a work. */
export function shaderPrelude(manifest: InstrumentManifest): string {
  return `${STD_UNIFORMS_GLSL}\n${macroDefines(manifest)}\n`;
}

export function stdUniforms() {
  return {
    uTime: { value: 0 },
    uResolution: { value: new Vector2(1, 1) },
    uFrame: { value: 0 },
    uBpm: { value: 120 },
    uBeat: { value: 0 },
    uBar: { value: 0 },
    uBeats: { value: 0 },
    uLow: { value: 0 },
    uMid: { value: 0 },
    uHigh: { value: 0 },
    uLevel: { value: 0 },
    uOnset: { value: 0 },
    uKick: { value: 0 },
    uTension: { value: 0 },
    uDrop: { value: 0 },
    uMacro: { value: new Float32Array(MAX_MACROS) },
  };
}

export type StdUniforms = ReturnType<typeof stdUniforms>;

export function updateStdUniforms(u: StdUniforms, f: Frame): void {
  const s = f.signals;
  u.uTime.value = s.time;
  u.uResolution.value.set(f.width, f.height);
  u.uFrame.value = s.frame;
  u.uBpm.value = s.bpm;
  u.uBeat.value = s.beat;
  u.uBar.value = s.bar;
  u.uBeats.value = s.beats;
  u.uLow.value = s.low;
  u.uMid.value = s.mid;
  u.uHigh.value = s.high;
  u.uLevel.value = s.level;
  u.uOnset.value = s.onset;
  u.uKick.value = s.kick;
  u.uTension.value = s.tension;
  u.uDrop.value = s.drop;
  u.uMacro.value.set(f.macros);
}
