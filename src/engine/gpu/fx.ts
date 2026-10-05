import { Vector2 } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { abs, atan, cos, exp, float, floor, length, mix, sin, uniform, vec2, vec3, vec4 } from 'three/tsl';
import type { MasterFx } from './DeckEngine';
import { FullscreenPass, hash12, passUv, sample, textureUniform } from './passes';

export function fxUniforms() {
  return {
    uTex: textureUniform(), uHistory: textureUniform(), uResolution: uniform(new Vector2(1, 1)),
    uTime: uniform(0), uBeat: uniform(0), uAmount: uniform(0), uDecay: uniform(0), uGate: uniform(1),
  };
}
export type FxUniforms = ReturnType<typeof fxUniforms>;

export function fxNode(kind: MasterFx, u: FxUniforms): Node {
  const p = passUv(), base = sample(u.uTex, p).rgb;
  switch (kind) {
    case 'feedback': return vec4(mix(base, sample(u.uHistory, p).rgb, u.uDecay), 1);
    case 'kaleido': {
      const aspect = u.uResolution.x.div(u.uResolution.y);
      const origin = vec2(0.43, 0.56), q = p.sub(origin).mul(vec2(aspect, 1));
      const sector = float(6.2831853).div(floor(u.uAmount.mul(9)).add(3));
      // GLSL mod is floor-based, whereas WGSL '%' is a remainder for negative angles.
      const angle0 = atan(q.y, q.x).add(sector.mul(0.5));
      const angle = abs(angle0.sub(floor(angle0.div(sector)).mul(sector)).sub(sector.mul(0.5)));
      const folded = origin.add(length(q).mul(vec2(cos(angle).div(aspect), sin(angle))));
      return vec4(mix(base, sample(u.uTex, folded.clamp(0, 1)).rgb, u.uAmount), 1);
    }
    case 'rgb-split': {
      const offset = vec2(14, 3).div(u.uResolution).mul(u.uAmount).mul(exp(u.uBeat.mul(-8)));
      return vec4(vec3(sample(u.uTex, p.add(offset).clamp(0, 1)).r, base.g,
        sample(u.uTex, p.sub(offset).clamp(0, 1)).b), 1);
    }
    case 'grain': {
      const n = hash12(p.mul(u.uResolution).add(floor(u.uTime.mul(24)).mul(17.13))).sub(0.5);
      return vec4(base.add(n.mul(u.uAmount).mul(0.06)).max(0), 1);
    }
    case 'strobe': return vec4(base.mul(mix(1, u.uGate, u.uAmount)), 1);
  }
}

export const createFxPass = (kind: MasterFx, u: FxUniforms) => new FullscreenPass(fxNode(kind, u));
