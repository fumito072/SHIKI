import { Vector2 } from 'three/webgpu';
import { fract, length, mix, smoothstep, uniform, vec2, vec4 } from 'three/tsl';
import { FullscreenPass, hash12, passUv, sample, textureUniform } from './passes';

export function finishUniforms() {
  return {
    uTex: textureUniform(), uResolution: uniform(new Vector2(1, 1)), uTime: uniform(0),
    uExposure: uniform(1), uVignette: uniform(0.35), uGrain: uniform(0.035),
  };
}
export type FinishUniforms = ReturnType<typeof finishUniforms>;

export function finishNode(u: FinishUniforms) {
  const p = passUv();
  const x = sample(u.uTex, p).rgb.mul(u.uExposure).max(0);
  const aces = x.mul(x.mul(2.51).add(0.03)).div(x.mul(x.mul(2.43).add(0.59)).add(0.14)).clamp(0, 1);
  const q = p.sub(0.5).mul(vec2(u.uResolution.x.div(u.uResolution.y), 1));
  // Explicit reversed smoothstep matches GLSL without depending on backend edge-order behavior.
  const v = length(q).sub(1.15).div(0.25 - 1.15).clamp(0, 1);
  const vignette = smoothstep(0, 1, v);
  // Preserve finish.frag's display encoding (gamma 2.2 approximation to sRGB).
  const display = aces.mul(mix(1, vignette, u.uVignette)).pow(1 / 2.2);
  const n = hash12(p.mul(u.uResolution).add(fract(u.uTime.mul(7.31)).mul(517))).sub(0.5);
  return vec4(display.add(n.mul(u.uGrain.add(1.5 / 255))), 1);
}

export const createFinishPass = (u: FinishUniforms) => new FullscreenPass(finishNode(u));
