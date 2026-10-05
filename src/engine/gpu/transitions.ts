import { Vector2 } from 'three/webgpu';
import type { Node } from 'three/webgpu';
import { dot, float, mix, sin, smoothstep, uniform, vec2, vec3, vec4 } from 'three/tsl';
import type { Transition } from '../deck/scheduling';
import { FullscreenPass, passUv, sample, textureUniform } from './passes';

export function transitionUniforms() {
  return {
    uFrom: textureUniform(), uTo: textureUniform(), uHistory: textureUniform(),
    uProgress: uniform(0), uResolution: uniform(new Vector2(1, 1)),
    uTime: uniform(0), uDt: uniform(0), uDecay: uniform(0),
  };
}
export type TransitionUniforms = ReturnType<typeof transitionUniforms>;

export function transitionNode(kind: Transition, u: TransitionUniforms): Node {
  const p = passUv();
  const from = sample(u.uFrom, p), to = sample(u.uTo, p);
  const t = u.uProgress;
  switch (kind) {
    case 'cut': return t.lessThan(1).select(from, to);
    case 'dissolve': return mix(from, to, t);
    case 'luma-wipe': {
      const l = dot(to.rgb, vec3(0.2126, 0.7152, 0.0722)).max(0);
      const threshold = float(1).sub(l.div(l.add(1)));
      const reveal = smoothstep(threshold.sub(0.06), threshold.add(0.06), t.mul(1.12).sub(0.06));
      return mix(from, to, reveal);
    }
    case 'displace': {
      const e = vec2(3).div(u.uResolution);
      const lightAt = (q: Node<'vec2'>) => {
        const l = dot(sample(u.uTo, q.clamp(0, 1)).rgb.max(0), vec3(0.2126, 0.7152, 0.0722));
        return l.div(l.add(1));
      };
      const gradient = vec2(
        lightAt(p.add(vec2(e.x, 0))).sub(lightAt(p.sub(vec2(e.x, 0)))),
        lightAt(p.add(vec2(0, e.y))).sub(lightAt(p.sub(vec2(0, e.y)))),
      );
      const displaced = p.sub(gradient.mul(sin(t.mul(3.14159265))).mul(0.24)).clamp(0, 1);
      return mix(sample(u.uFrom, displaced), to, t);
    }
    case 'feedback-melt': {
      const bend = sin(p.x.mul(19).add(u.uTime.mul(0.37))).mul(sin(p.y.mul(11).sub(u.uTime.mul(0.21))));
      const drift = vec2(bend.mul(0.018), bend.mul(0.018).add(0.012).negate()).mul(u.uDt).mul(t);
      const history = sample(u.uHistory, p.sub(drift).clamp(0, 1)).rgb;
      const melting = mix(from.rgb, history, u.uDecay.mul(smoothstep(0, 0.12, t)));
      return vec4(mix(melting, to.rgb, t), 1);
    }
  }
}

export const createTransitionPass = (kind: Transition, u: TransitionUniforms) => new FullscreenPass(transitionNode(kind, u));
