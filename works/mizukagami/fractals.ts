// The thirteen worlds of MIZUKAGAMI's descent. Each one draws itself into its own target at a zoom z (1 → Z across its
// segment of the journey), centred on the point we dive into, in its own colours. Most are drawn as distance fields
// (thin lines with a glow, the inside filled faintly); Lyapunov is a field, Menger a ray-marched solid, the fern a
// chaos-game density, the Romanesco a lit relief of spirals within spirals.
import { MeshBasicNodeMaterial, Vector2, Vector3 } from 'three/webgpu';
import type { Node, WebGPURenderer } from 'three/webgpu';
import {
  Break, Fn, If, Loop, abs, atomicAdd, atomicLoad, atomicMax, atomicStore, clamp, cos, exp, float, floor, hash, instanceIndex,
  instancedArray, int, length, log, log2, max, min, mix, normalize, pow, select, sin, smoothstep, sqrt, uint, uniform, uv, vec2,
  vec3, vec4,
} from 'three/tsl';

const floatU = () => uniform(0);
const vec2U = () => uniform(new Vector2());
export type UFloat = ReturnType<typeof floatU>;
export type UVec2 = ReturnType<typeof vec2U>;
/** Uniforms every world shares. */
export interface Shared {
  time: UFloat;
  aspect: UFloat;
  height: UFloat; // target height in pixels
  fold: UVec2; // Möbius fold t
  pulse: UFloat; // kick flash
  invert: UFloat; // figure/ground swap after a drop
  line: UFloat; // line brightness
  halo: UFloat; // glow width
}
export function sharedUniforms(width: number, height: number): Shared {
  return {
    time: floatU(), aspect: uniform(width / height), height: uniform(height), fold: vec2U(),
    pulse: floatU(), invert: floatU(), line: uniform(0.5), halo: uniform(0.4),
  };
}

export interface World {
  id: string;
  label: string;
  /** Zoom across its segment. */
  Z: number;
  material: MeshBasicNodeMaterial;
  z: UFloat;
  /** Work that must run before drawing (the fern's chaos game). */
  prepare?: (renderer: WebGPURenderer, width: number, height: number) => void;
  dispose(): void;
}

type V2 = Node<'vec2'>;
type F1 = Node<'float'>;
type V3 = Node<'vec3'>;

// ------------------------------------------------------------------ shared helpers
/** Screen point (y up, in screen heights) after the drop's Möbius fold w / (1 − t·w). */
function screenQ(S: Shared): V2 {
  const q = vec2(uv().x.sub(0.5).mul(S.aspect), float(0.5).sub(uv().y));
  const t = S.fold;
  const den = vec2(float(1).sub(t.x.mul(q.x)).add(t.y.mul(q.y)), t.x.mul(q.y).add(t.y.mul(q.x)).negate());
  const dd = den.dot(den).add(1e-6);
  return vec2(q.x.mul(den.x).add(q.y.mul(den.y)), q.y.mul(den.x).sub(q.x.mul(den.y))).div(dd);
}
const rot = (p: V2, a: F1 | number) => {
  const c = cos(a);
  const s = sin(a);
  return vec2(p.x.mul(c).sub(p.y.mul(s)), p.x.mul(s).add(p.y.mul(c)));
};
const fmod = (x: F1, y: number) => x.sub(floor(x.div(y)).mul(y));
const segD = (p: V2, a: [number, number], b: [number, number]) => {
  const pa = p.sub(vec2(a[0], a[1]));
  const ba = vec2(b[0] - a[0], b[1] - a[1]);
  const h = clamp(pa.dot(ba).div(ba.dot(ba)), 0, 1);
  return length(pa.sub(ba.mul(h)));
};
/** Mirror-tile the plane into [0,1]² so a curve on the unit square continues across tiles. */
const mirrorTile = (p: V2) => {
  const f = vec2(fmod(p.x, 2), fmod(p.y, 2));
  return vec2(select(f.x.greaterThan(1), float(2).sub(f.x), f.x), select(f.y.greaterThan(1), float(2).sub(f.y), f.y));
};
const step0 = (x: F1) => clamp(x.mul(1e3), 0, 1);

interface Palette {
  edge: [number, number, number]; halo: [number, number, number]; fill: [number, number, number]; bg: [number, number, number];
  /** Glow strength and width (dense structures need less, or the screen saturates). */
  glow?: number; width?: number;
}

/** A distance in pixels to the structure → a thin hot line with a glow, the inside filled faintly. */
function paint(S: Shared, dpx: F1, inside: F1, pal: Palette, extra: V3 = vec3(0, 0, 0)): Node<'vec4'> {
  const core = smoothstep(1.4, 0, dpx);
  const w = pal.width ?? 1;
  const glow = exp(dpx.div(S.halo.mul(6).add(1.5).add(S.pulse.mul(4)).mul(w)).negate()).mul(0.75).add(exp(dpx.div(40 * w).negate()).mul(0.12)).mul(pal.glow ?? 1);
  const lift = S.pulse.mul(1.5).add(1);
  const col = vec3(...pal.bg)
    .add(vec3(...pal.fill).mul(inside))
    .add(vec3(...pal.edge).mul(core).mul(S.line.mul(1.4).add(0.4)).mul(lift))
    .add(vec3(...pal.halo).mul(glow).mul(lift))
    .add(extra);
  // after a drop: figure and ground swap — the void lights up in the halo colour, the structure goes dark
  const inverted = vec3(...pal.halo).mul(0.35).mul(float(1).sub(core).sub(glow.mul(0.6)).max(0)).add(vec3(...pal.fill).mul(inside).mul(0.3));
  return vec4(mix(col, inverted, S.invert.mul(0.75)), 1);
}
/** The same swap for worlds that compute their own colour. */
const invertable = (S: Shared, col: V3) => vec4(mix(col, vec3(1).sub(col.clamp(0, 1)).mul(0.35), S.invert.mul(0.75)), 1);

/** Local coordinates of the world at this pixel: centre + rotated screen point × span / zoom. */
const local = (S: Shared, z: F1, centre: [number, number], span: number, spin: F1 | number = 0) =>
  vec2(centre[0], centre[1]).add(rot(screenQ(S), spin).mul(span).div(z));
/** Local units per pixel. */
const perPx = (S: Shared, z: F1, span: number) => float(span).div(z).div(S.height);

// ------------------------------------------------------------------ escape time: Mandelbrot, Julia, Burning Ship
type Escape = 'mandelbrot' | 'julia' | 'ship';
function escapeSample(kind: Escape, k: [number, number], maxIt: number) {
  return Fn(([p]: [V2]) => {
    const isJ = kind === 'julia';
    const c = isJ ? vec2(k[0], k[1]) : kind === 'ship' ? vec2(p.x, p.y.negate()) : p;
    const zr = (isJ ? p.x : float(0)).toVar();
    const zi = (isJ ? p.y : float(0)).toVar();
    const dr = float(isJ ? 1 : 0).toVar();
    const di = float(0).toVar();
    const it = float(0).toVar();
    const esc = float(0).toVar();
    const one = float(isJ ? 0 : 1).toVar();
    const logScale = float(0).toVar(); // the derivative is kept scaled down so it never overflows float32
    Loop({ start: int(0), end: int(maxIt), type: 'int', condition: '<' }, () => {
      if (kind === 'ship') {
        const ax = abs(zr).toVar();
        const ay = abs(zi).toVar();
        const vr = dr.mul(select(zr.lessThan(0), float(-1), float(1))).toVar();
        const vi = di.mul(select(zi.lessThan(0), float(-1), float(1))).toVar();
        dr.assign(ax.mul(vr).sub(ay.mul(vi)).mul(2).add(one));
        di.assign(ax.mul(vi).add(ay.mul(vr)).mul(2));
        zr.assign(ax.mul(ax).sub(ay.mul(ay)).add(c.x));
        zi.assign(ax.mul(ay).mul(2).add(c.y));
      } else {
        const ndr = zr.mul(dr).sub(zi.mul(di)).mul(2).add(one).toVar();
        const ndi = zr.mul(di).add(zi.mul(dr)).mul(2).toVar();
        const nzr = zr.mul(zr).sub(zi.mul(zi)).add(c.x).toVar();
        const nzi = zr.mul(zi).mul(2).add(c.y).toVar();
        dr.assign(ndr);
        di.assign(ndi);
        zr.assign(nzr);
        zi.assign(nzi);
      }
      it.addAssign(1);
      const dd = dr.mul(dr).add(di.mul(di));
      If(dd.greaterThan(1e16), () => {
        const k = dd.sqrt();
        dr.divAssign(k);
        di.divAssign(k);
        one.divAssign(k);
        logScale.addAssign(log(k));
      });
      If(zr.mul(zr).add(zi.mul(zi)).greaterThan(1e6), () => {
        esc.assign(1);
        Break();
      });
    });
    const m2 = zr.mul(zr).add(zi.mul(zi));
    const den = dr.mul(dr).add(di.mul(di)).add(1e-30);
    const mu = it.add(1).sub(log2(log(m2).mul(0.5)));
    // |z| log|z| / |z'|, with |z'| = |scaled z'| · e^logScale (in log space, so it cannot overflow)
    const logDist = log(m2.sqrt().mul(log(m2).mul(0.5))).sub(log(den).mul(0.5)).sub(logScale);
    const dist = select(esc.greaterThan(0.5), exp(logDist), float(-1));
    return vec2(dist, mu);
  });
}

function escapeWorld(S: Shared, id: string, label: string, kind: Escape, o: { centre: [number, number]; span: number; Z: number; k?: [number, number]; spin?: number; maxIt: number; pal: Palette }): World {
  const z = uniform(1);
  const sample = escapeSample(kind, o.k ?? [0, 0], o.maxIt);
  const material = new MeshBasicNodeMaterial();
  material.colorNode = Fn(() => {
    const spin = o.spin ? log(z).mul(o.spin) : 0;
    const p = local(S, z, o.centre, o.span, spin);
    const s = sample(p);
    const inside = s.x.lessThan(0).select(1, 0);
    const outside = float(1).sub(inside);
    const dpx = select(s.x.lessThan(0), float(0), s.x.div(perPx(S, z, o.span)));
    // dense filaments would fill the screen as lines: draw the escape time as thin bands of light that flow inward,
    // and the edge itself only as a faint line
    const lift = S.pulse.mul(1.5).add(1);
    const phase = log(s.y.add(1)).mul(3.2).sub(S.time.mul(0.45));
    const band = pow(sin(phase).mul(0.5).add(0.5), float(10)).mul(S.line.mul(0.9).add(0.35));
    const depth = clamp(log(s.y.add(1)).div(Math.log(o.maxIt)), 0, 1);
    const halo = vec3(...o.pal.halo);
    const col = vec3(...o.pal.bg)
      .add(halo.mul(depth.pow(2).mul(0.22)).mul(outside))
      .add(mix(halo, vec3(...o.pal.edge), 0.35).mul(band).mul(outside).mul(lift))
      .add(vec3(...o.pal.edge).mul(smoothstep(1.2, 0, dpx)).mul(0.5).mul(outside))
      .add(vec3(...o.pal.fill).mul(inside));
    return invertable(S, col);
  })();
  return { id, label, Z: o.Z, material, z, dispose: () => material.dispose() };
}

// ------------------------------------------------------------------ Lyapunov (sequence AABAB on the logistic map)
function lyapunovWorld(S: Shared): World {
  const z = uniform(1);
  const material = new MeshBasicNodeMaterial();
  const sample = Fn(([p]: [V2]) => {
    const x = float(0.5).toVar();
    const lam = float(0).toVar();
    Loop({ start: int(0), end: int(140), type: 'int', condition: '<' }, ({ i }) => {
      const k = i.mod(5);
      const r = select(k.equal(2).or(k.equal(4)), p.y, p.x);
      x.assign(r.mul(x).mul(float(1).sub(x)));
      If(i.greaterThanEqual(30), () => {
        lam.addAssign(log(abs(r.mul(float(1).sub(x.mul(2)))).add(1e-6)));
      });
    });
    return lam.div(110);
  });
  material.colorNode = Fn(() => {
    const p = local(S, z, [3.42, 3.62], 0.9, 0);
    const lam = sample(p);
    const stable = clamp(lam.negate().mul(1.4), 0, 1);
    const chaos = clamp(lam.mul(2.5), 0, 1);
    const gold = vec3(1.0, 0.72, 0.25).mul(pow(stable, 0.55)).mul(S.line.mul(0.8).add(0.5));
    const edge = exp(abs(lam).mul(-28)).mul(S.pulse.mul(1.5).add(1));
    const teal = vec3(0.05, 0.45, 0.55).mul(chaos.mul(0.25));
    return invertable(S, gold.add(teal).add(vec3(1.0, 0.95, 0.8).mul(edge).mul(0.9)));
  })();
  return { id: 'lyapunov', label: 'Lyapunov', Z: 6, material, z, dispose: () => material.dispose() };
}

// ------------------------------------------------------------------ Cantor dust (C × C), diving at (1/4, 1/4) — 9× self-similar
function cantorWorld(S: Shared): World {
  const z = uniform(1);
  const material = new MeshBasicNodeMaterial();
  const dist1 = Fn(([x0, levels]: [F1, Node<'int'>]) => {
    const x = x0.toVar();
    const s = float(1).toVar();
    const d = float(0).toVar();
    const out = max(max(x0.negate(), x0.sub(1)), 0);
    Loop({ start: int(0), end: levels, type: 'int', condition: '<' }, () => {
      If(x.lessThan(1 / 3), () => {
        x.mulAssign(3);
        s.mulAssign(3);
      }).ElseIf(x.greaterThan(2 / 3), () => {
        x.assign(x.mul(3).sub(2));
        s.mulAssign(3);
      }).Else(() => {
        d.assign(min(x.sub(1 / 3), float(2 / 3).sub(x)).div(s));
        Break();
      });
    });
    return select(out.greaterThan(0), out, d);
  });
  material.colorNode = Fn(() => {
    const span = 1.1;
    const p = local(S, z, [0.25, 0.25], span);
    const levels = int(float(7).add(log(z).div(Math.log(3))));
    const d = length(vec2(dist1(p.x, levels), dist1(p.y, levels)));
    const dpx = d.div(perPx(S, z, span));
    return paint(S, dpx, smoothstep(0.8, 0, dpx), { edge: [1, 1, 1], halo: [0.55, 0.65, 0.8], fill: [0.85, 0.88, 0.95], bg: [0.004, 0.004, 0.006] });
  })();
  return { id: 'cantor', label: 'Cantor', Z: 81, material, z, dispose: () => material.dispose() };
}

// ------------------------------------------------------------------ Sierpinski gasket, diving at (2A + B)/3 — 4× self-similar
function sierpinskiWorld(S: Shared): World {
  const z = uniform(1);
  const material = new MeshBasicNodeMaterial();
  const A: [number, number] = [0, 1];
  const B: [number, number] = [-0.8660254, -0.5];
  const C: [number, number] = [0.8660254, -0.5];
  const sdTri = (p0: V2) => {
    const r = 0.8660254;
    const k = Math.sqrt(3);
    const p = vec2(abs(p0.x).sub(r), p0.y.add(r / k)).toVar();
    If(p.x.add(p.y.mul(k)).greaterThan(0), () => {
      p.assign(vec2(p.x.sub(p.y.mul(k)), p.x.mul(-k).sub(p.y)).mul(0.5));
    });
    p.x.subAssign(clamp(p.x, -2 * r, 0));
    return length(p).negate().mul(select(p.y.lessThan(0), float(-1), float(1)));
  };
  material.colorNode = Fn(() => {
    const span = 2.4;
    const centre: [number, number] = [(2 * A[0] + B[0]) / 3, (2 * A[1] + B[1]) / 3];
    const p = local(S, z, centre, span).toVar();
    const s = float(1).toVar();
    const levels = int(float(7).add(log(z).div(Math.log(2))));
    Loop({ start: int(0), end: levels, type: 'int', condition: '<' }, () => {
      const da = length(p.sub(vec2(...A)));
      const db = length(p.sub(vec2(...B)));
      const dc = length(p.sub(vec2(...C)));
      const v = select(da.lessThan(db).and(da.lessThan(dc)), vec2(...A), select(db.lessThan(dc), vec2(...B), vec2(...C)));
      p.assign(p.mul(2).sub(v));
      s.mulAssign(2);
    });
    const d = sdTri(p).div(s);
    const dpx = abs(d).div(perPx(S, z, span));
    return paint(S, dpx, d.lessThan(0).select(1, 0), { edge: [0.8, 1, 1], halo: [0.1, 0.75, 1.0], fill: [0.0, 0.1, 0.14], bg: [0.002, 0.004, 0.006] });
  })();
  return { id: 'sierpinski', label: 'Sierpinski', Z: 64, material, z, dispose: () => material.dispose() };
}

// ------------------------------------------------------------------ Koch snowflake (folding, after The Art of Code)
function kochWorld(S: Shared): World {
  const z = uniform(1);
  const material = new MeshBasicNodeMaterial();
  material.colorNode = Fn(() => {
    const span = 1.15;
    const p = local(S, z, [0.0, -0.2887], span).toVar();
    p.x.assign(abs(p.x));
    const a1 = (5 / 6) * Math.PI;
    const n1 = vec2(Math.sin(a1), Math.cos(a1));
    p.y.addAssign(Math.tan(a1) * 0.5);
    const d1 = p.sub(vec2(0.5, 0)).dot(n1);
    p.subAssign(n1.mul(max(d1, 0)).mul(2));
    const a2 = (2 / 3) * Math.PI;
    const n2 = vec2(Math.sin(a2), Math.cos(a2));
    const scale = float(1).toVar();
    p.x.addAssign(0.5);
    const levels = int(float(5).add(log(z).div(Math.log(3))));
    Loop({ start: int(0), end: levels, type: 'int', condition: '<' }, () => {
      p.mulAssign(3);
      scale.mulAssign(3);
      p.x.subAssign(1.5);
      p.x.assign(abs(p.x));
      p.x.subAssign(0.5);
      const d2 = p.dot(n2);
      p.subAssign(n2.mul(min(d2, 0)).mul(2));
    });
    const d = length(p.sub(vec2(clamp(p.x, -1, 1), 0))).div(scale);
    const dpx = d.div(perPx(S, z, span));
    return paint(S, dpx, float(0), { edge: [0.92, 0.96, 1], halo: [0.45, 0.7, 1.0], fill: [0.02, 0.05, 0.12], bg: [0.002, 0.003, 0.006] });
  })();
  return { id: 'koch', label: 'Koch', Z: 27, material, z, dispose: () => material.dispose() };
}

// ------------------------------------------------------------------ Takagi (blancmange) curve
function takagiWorld(S: Shared): World {
  const z = uniform(1);
  const material = new MeshBasicNodeMaterial();
  material.colorNode = Fn(() => {
    const span = 1.1;
    const p = local(S, z, [0.5, 0.5], span);
    const T = float(0).toVar();
    const f = float(1).toVar();
    const levels = int(float(12).add(log(z).div(Math.log(2))));
    Loop({ start: int(0), end: levels, type: 'int', condition: '<' }, () => {
      const t = p.x.mul(f);
      T.addAssign(abs(t.sub(floor(t.add(0.5)))).div(f));
      f.mulAssign(2);
    });
    const d = p.y.sub(T);
    const dpx = abs(d).div(perPx(S, z, span)).div(2.2);
    return paint(S, dpx, d.lessThan(0).select(0.8, 0), { edge: [1, 0.85, 0.95], halo: [1.0, 0.15, 0.55], fill: [0.1, 0.0, 0.05], bg: [0.004, 0.0, 0.003] });
  })();
  return { id: 'takagi', label: 'Takagi', Z: 16, material, z, dispose: () => material.dispose() };
}

// ------------------------------------------------------------------ Peano curve (3×3 serpentine), 9× self-similar at the centre
function peanoWorld(S: Shared): World {
  const z = uniform(1);
  const material = new MeshBasicNodeMaterial();
  const path: [number, number][] = [
    [0, 0], [1 / 6, 1 / 6], [1 / 6, 1 / 2], [1 / 6, 5 / 6], [1 / 2, 5 / 6], [1 / 2, 1 / 2], [1 / 2, 1 / 6],
    [5 / 6, 1 / 6], [5 / 6, 1 / 2], [5 / 6, 5 / 6], [1, 1],
  ];
  material.colorNode = Fn(() => {
    const span = 1.15;
    const p = mirrorTile(local(S, z, [0.5, 0.5], span)).toVar();
    const s = float(1).toVar();
    const levels = int(float(3).add(log(z).div(Math.log(3))));
    Loop({ start: int(0), end: levels, type: 'int', condition: '<' }, () => {
      p.mulAssign(3);
      const i = clamp(floor(p.x), 0, 2).toVar();
      const j = clamp(floor(p.y), 0, 2).toVar();
      p.subAssign(vec2(i, j));
      If(fmod(i, 2).greaterThan(0.5), () => {
        p.y.assign(float(1).sub(p.y));
      });
      If(fmod(j, 2).greaterThan(0.5), () => {
        p.x.assign(float(1).sub(p.x));
      });
      s.mulAssign(3);
    });
    let d: F1 = float(1e9);
    for (let k = 0; k < path.length - 1; k++) d = min(d, segD(p, path[k], path[k + 1]));
    const dpx = d.div(s).div(perPx(S, z, span));
    return paint(S, dpx, float(0), { edge: [1, 0.95, 0.8], halo: [1.0, 0.6, 0.1], fill: [0, 0, 0], bg: [0.005, 0.003, 0.0], glow: 0.4, width: 0.5 });
  })();
  return { id: 'peano', label: 'Peano', Z: 27, material, z, dispose: () => material.dispose() };
}

// ------------------------------------------------------------------ Hilbert curve (exact: cell index ± 1)
function hilbertWorld(S: Shared): World {
  const z = uniform(1);
  const material = new MeshBasicNodeMaterial();
  /** Hilbert index of cell (x, y) on an n×n grid (n = 2^lev). */
  const xy2d = Fn(([x0, y0, n, lev]: [Node<'int'>, Node<'int'>, Node<'int'>, Node<'int'>]) => {
    const x = x0.toVar();
    const y = y0.toVar();
    const d = int(0).toVar();
    Loop({ start: int(0), end: lev, type: 'int', condition: '<' }, ({ i }) => {
      const s = n.shiftRight(i.add(1)).toVar();
      const rx = select(x.bitAnd(s).greaterThan(0), int(1), int(0)).toVar();
      const ry = select(y.bitAnd(s).greaterThan(0), int(1), int(0)).toVar();
      d.addAssign(s.mul(s).mul(rx.mul(3).bitXor(ry)));
      If(ry.equal(0), () => {
        If(rx.equal(1), () => {
          x.assign(n.sub(1).sub(x));
          y.assign(n.sub(1).sub(y));
        });
        const t = x.toVar();
        x.assign(y);
        y.assign(t);
      });
    });
    return d;
  });
  /** Cell centre of Hilbert index d on an n×n grid. */
  const d2xy = Fn(([d, lev]: [Node<'int'>, Node<'int'>]) => {
    const x = int(0).toVar();
    const y = int(0).toVar();
    const t = d.toVar();
    Loop({ start: int(0), end: lev, type: 'int', condition: '<' }, ({ i }) => {
      const s = int(1).shiftLeft(i).toVar();
      const rx = int(1).bitAnd(t.shiftRight(1)).toVar();
      const ry = int(1).bitAnd(t.bitXor(rx)).toVar();
      If(ry.equal(0), () => {
        If(rx.equal(1), () => {
          x.assign(s.sub(1).sub(x));
          y.assign(s.sub(1).sub(y));
        });
        const tmp = x.toVar();
        x.assign(y);
        y.assign(tmp);
      });
      x.addAssign(s.mul(rx));
      y.addAssign(s.mul(ry));
      t.assign(t.shiftRight(2));
    });
    return vec2(x.toFloat().add(0.5), y.toFloat().add(0.5));
  });
  material.colorNode = Fn(() => {
    const span = 1.15;
    const p = mirrorTile(local(S, z, [0.5, 0.5], span));
    const lev = int(clamp(float(4).add(log(z).div(Math.log(2))), 1, 14)).toVar();
    const n = int(1).shiftLeft(lev).toVar();
    const nf = n.toFloat();
    const g = p.mul(nf);
    const cx = int(clamp(floor(g.x), 0, nf.sub(1)));
    const cy = int(clamp(floor(g.y), 0, nf.sub(1)));
    const d = xy2d(cx, cy, n, lev);
    const here = vec2(cx.toFloat().add(0.5), cy.toFloat().add(0.5));
    const last = n.mul(n).sub(1);
    const prev = d2xy(select(d.greaterThan(0), d.sub(1), int(0)), lev);
    const next = d2xy(select(d.lessThan(last), d.add(1), last), lev);
    const seg = (a: V2, b: V2) => {
      const pa = g.sub(a);
      const ba = b.sub(a);
      const h = clamp(pa.dot(ba).div(ba.dot(ba).add(1e-6)), 0, 1);
      return length(pa.sub(ba.mul(h)));
    };
    const dc = min(seg(here, prev), seg(here, next)).div(nf);
    const dpx = dc.div(perPx(S, z, span));
    return paint(S, dpx, float(0), { edge: [0.85, 0.9, 1], halo: [0.2, 0.35, 1.0], fill: [0, 0, 0], bg: [0.002, 0.002, 0.006], glow: 0.55, width: 0.6 });
  })();
  return { id: 'hilbert', label: 'Hilbert', Z: 32, material, z, dispose: () => material.dispose() };
}

// ------------------------------------------------------------------ Menger sponge: ray-marched, flying at a corner — 3× self-similar
function mengerWorld(S: Shared): World {
  const z = uniform(1);
  const material = new MeshBasicNodeMaterial();
  const fm3 = (v: V3, m: number) => v.sub(floor(v.div(m)).mul(m));
  const de = Fn(([p, iters]: [V3, Node<'int'>]) => {
    const q = abs(p).sub(1);
    const d = length(max(q, vec3(0, 0, 0))).add(min(max(q.x, max(q.y, q.z)), 0)).toVar();
    const s = float(1).toVar();
    Loop({ start: int(0), end: iters, type: 'int', condition: '<' }, () => {
      const a = fm3(p.mul(s), 2).sub(1);
      s.mulAssign(3);
      const r = abs(float(1).sub(abs(a).mul(3)));
      const da = max(r.x, r.y);
      const db = max(r.y, r.z);
      const dc = max(r.z, r.x);
      d.assign(max(d, min(da, min(db, dc)).sub(1).div(s)));
    });
    return d;
  });
  material.colorNode = Fn(() => {
    const q = screenQ(S);
    const corner = vec3(1, 1, 1);
    const back = normalize(vec3(1.0, 0.82, 1.18));
    const eye = corner.add(back.mul(2.6).div(z));
    const fwd = back.negate();
    const right = normalize(vec3(fwd.z, 0, fwd.x.negate()));
    const up = right.cross(fwd);
    const dir = normalize(fwd.add(right.mul(q.x).mul(1.1)).add(up.mul(q.y).mul(1.1)));
    const iters = int(clamp(float(4).add(log(z).div(Math.log(3))), 4, 9));
    const t = float(0).toVar();
    const hit = float(0).toVar();
    const steps = float(0).toVar();
    const eps = float(0.0012).div(z);
    Loop({ start: int(0), end: int(110), type: 'int', condition: '<' }, () => {
      const dd = de(eye.add(dir.mul(t)), iters);
      If(dd.lessThan(eps.mul(t.mul(z).add(1))), () => {
        hit.assign(1);
        Break();
      });
      t.addAssign(dd);
      steps.addAssign(1);
      If(t.greaterThan(float(8).div(z)), () => {
        Break();
      });
    });
    const pos = eye.add(dir.mul(t));
    const e = float(0.0006).div(z);
    const nrm = normalize(vec3(
      de(pos.add(vec3(e, 0, 0)), iters).sub(de(pos.sub(vec3(e, 0, 0)), iters)),
      de(pos.add(vec3(0, e, 0)), iters).sub(de(pos.sub(vec3(0, e, 0)), iters)),
      de(pos.add(vec3(0, 0, e)), iters).sub(de(pos.sub(vec3(0, 0, e)), iters)),
    ));
    const ao = float(1).sub(steps.div(110)).pow(2);
    const light = normalize(vec3(0.6, 0.9, 0.3));
    const diff = max(nrm.dot(light), 0);
    const rim = pow(float(1).sub(max(nrm.dot(dir.negate()), 0)), 3);
    const stone = vec3(0.95, 0.78, 0.6);
    const lit = stone.mul(diff.mul(0.9).add(0.12)).mul(ao).mul(S.line.mul(0.8).add(0.6)).add(vec3(1.0, 0.6, 0.3).mul(rim).mul(0.5)).mul(S.pulse.mul(1.2).add(1));
    const fog = exp(t.mul(z).mul(-0.35));
    return invertable(S, select(hit.greaterThan(0.5), lit.mul(fog), vec3(0.01, 0.006, 0.004)));
  })();
  return { id: 'menger', label: 'Menger', Z: 27, material, z, dispose: () => material.dispose() };
}

// ------------------------------------------------------------------ Barnsley fern: chaos game into a histogram, diving at its tip
const FERN_THREADS = 131072;
function fernWorld(S: Shared): World {
  const z = uniform(1);
  const material = new MeshBasicNodeMaterial();
  const HW = 960;
  const HH = 540;
  const hist = instancedArray(HW * HH, 'uint').toAtomic();
  const dens = instancedArray(HW * HH + 1, 'float');
  const peak = instancedArray(1, 'uint').toAtomic();
  const F = { frame: uniform(0), k: uniform(0), aspect: uniform(16 / 9), rest: uniform(1) };
  // the tip is the fixed point of f2 (x' = .85x + .04y, y' = −.04x + .85y + 1.6)
  const tip = new Vector3(2.6556, 9.9585, 0);
  const span = 11;
  const clear = Fn(() => {
    atomicStore(hist.element(instanceIndex), uint(0));
    If(instanceIndex.equal(0), () => {
      atomicStore(peak.element(0), uint(0));
    });
  })().compute(HW * HH);
  const f2 = (p: V2) => vec2(p.x.mul(0.85).add(p.y.mul(0.04)), p.x.mul(-0.04).add(p.y.mul(0.85)).add(1.6));
  const game = Fn(() => {
    const seed = instanceIndex.add(F.frame.mod(4000).mul(FERN_THREADS).toUint());
    const p = vec2(0, 0).toVar();
    Loop({ start: int(0), end: int(26), type: 'int', condition: '<' }, ({ i: k }) => {
      const r = hash(seed.mul(29).add(k.toUint()));
      If(r.lessThan(0.01), () => {
        p.assign(vec2(0, p.y.mul(0.16)));
      }).ElseIf(r.lessThan(0.86), () => {
        p.assign(f2(p));
      }).ElseIf(r.lessThan(0.93), () => {
        p.assign(vec2(p.x.mul(0.2).sub(p.y.mul(0.26)), p.x.mul(0.23).add(p.y.mul(0.22)).add(1.6)));
      }).Else(() => {
        p.assign(vec2(p.x.mul(-0.15).add(p.y.mul(0.28)), p.x.mul(0.26).add(p.y.mul(0.24)).add(0.44)));
      });
      If(k.greaterThanEqual(8), () => {
        // push the point towards the tip as deep as we are zoomed, so the view stays full at any depth
        const q = p.toVar();
        Loop({ start: int(0), end: int(F.k), type: 'int', condition: '<' }, () => {
          q.assign(f2(q));
        });
        const sp = q.sub(vec2(tip.x, tip.y)).mul(F.rest).div(span);
        const u = sp.x.div(F.aspect).add(0.5);
        const v = sp.y.add(0.5);
        If(u.greaterThanEqual(0).and(u.lessThan(1)).and(v.greaterThanEqual(0)).and(v.lessThan(1)), () => {
          atomicAdd(hist.element(floor(v.mul(HH)).mul(HW).add(floor(u.mul(HW))).toUint()), uint(1));
        });
      });
    });
  })().compute(FERN_THREADS);
  const resolve = Fn(() => {
    const n = atomicLoad(hist.element(instanceIndex));
    dens.element(instanceIndex).assign(n.toFloat());
    atomicMax(peak.element(0), n);
    If(instanceIndex.equal(0), () => {
      dens.element(HW * HH).assign(atomicLoad(peak.element(0)).toFloat());
    });
  })().compute(HW * HH);
  material.colorNode = Fn(() => {
    const q = screenQ(S);
    const u = q.x.div(S.aspect).add(0.5);
    const v = q.y.add(0.5);
    const ok = u.greaterThanEqual(0).and(u.lessThan(1)).and(v.greaterThanEqual(0)).and(v.lessThan(1));
    const idx = floor(clamp(v, 0, 0.9999).mul(HH)).mul(HW).add(floor(clamp(u, 0, 0.9999).mul(HW))).toUint();
    const c = select(ok, dens.element(idx), float(0));
    const pk = max(dens.element(HW * HH), 1);
    const g = log(c.add(1)).div(log(pk.add(1))).pow(0.8);
    const col = vec3(0.004, 0.006, 0.004)
      .add(vec3(0.3, 1.0, 0.45).mul(g).mul(S.line.mul(1.2).add(0.5)).mul(S.pulse.mul(1.5).add(1)))
      .add(vec3(0.85, 1.0, 0.85).mul(g.pow(3)).mul(0.6));
    return invertable(S, col);
  })();
  let frame = 0;
  return {
    id: 'fern', label: 'Barnsley fern', Z: 30, material, z,
    prepare(renderer, width, height) {
      const zoom = Math.max(1, Number(z.value));
      // dive by whole applications of f2 (×1/0.85 each, exact self-similarity) and leave the remainder to the view
      const k = Math.max(0, Math.floor(Math.log(zoom) / Math.log(1 / 0.85)) - 1);
      F.k.value = k;
      F.rest.value = zoom * Math.pow(0.85, k);
      F.frame.value = frame++;
      F.aspect.value = width / height;
      renderer.compute(clear);
      renderer.compute(game);
      renderer.compute(resolve);
    },
    dispose() {
      material.dispose();
      [clear, game, resolve].forEach((kernel) => kernel.dispose());
    },
  };
}

// ------------------------------------------------------------------ Romanesco: phyllotaxis spirals of cones within cones
function romanescoWorld(S: Shared): World {
  const z = uniform(1);
  const material = new MeshBasicNodeMaterial();
  const GOLD = Math.PI * (3 - Math.sqrt(5));
  const OFFS = [-34, -21, -13, -8, -5, -3, -2, -1, 0, 1, 2, 3, 5, 8, 13, 21, 34];
  /** Nearest floret of a Vogel spiral with spacing sp: the point in that floret's frame (radius 1) and its height. */
  const floret = (p: V2, sp: number, nMax: number) => {
    const n0 = floor(length(p).div(sp).pow(2).add(0.5));
    let best: F1 = float(1e9);
    let bestN: F1 = float(0);
    for (const o of OFFS) {
      const n = clamp(n0.add(o), 1, nMax);
      const c = vec2(cos(n.mul(GOLD)), sin(n.mul(GOLD))).mul(sqrt(n).mul(sp));
      const dd = length(p.sub(c));
      const closer = dd.lessThan(best);
      bestN = select(closer, n, bestN);
      best = select(closer, dd, best);
    }
    const rho = float(sp * 0.62).mul(float(1).add(sqrt(bestN).mul(0.04)));
    const c = vec2(cos(bestN.mul(GOLD)), sin(bestN.mul(GOLD))).mul(sqrt(bestN).mul(sp));
    const lp = rot(p.sub(c), bestN.mul(GOLD).negate()).div(rho);
    return { lp, h: float(1).sub(best.div(rho)) };
  };
  material.colorNode = Fn(() => {
    const n40 = 40;
    const sp = 0.075;
    const centre: [number, number] = [Math.cos(n40 * GOLD) * Math.sqrt(n40) * sp, Math.sin(n40 * GOLD) * Math.sqrt(n40) * sp];
    const span = 2.0;
    const p = local(S, z, centre, span);
    const a = floret(p, sp, 400);
    const b = floret(a.lp, 0.11, 120);
    const h1 = clamp(a.h, 0, 1);
    const h2 = clamp(b.h, 0, 1).mul(step0(a.h));
    const height = h1.mul(0.7).add(h2.mul(0.3));
    // light the cones: each slopes toward its own centre
    const g1 = normalize(a.lp.add(vec2(1e-4, 0))).mul(h1.greaterThan(0).select(0.8, 0));
    const g2 = normalize(b.lp.add(vec2(1e-4, 0))).mul(h2.greaterThan(0).select(0.5, 0));
    const nrm = normalize(vec3(g1.x.add(g2.x), g1.y.add(g2.y), 1.2));
    const light = normalize(vec3(-0.5, 0.6, 0.8));
    const diff = max(nrm.dot(light), 0);
    const base = mix(vec3(0.25, 0.42, 0.06), vec3(0.75, 0.98, 0.35), height);
    const lit = base.mul(diff.mul(0.85).add(0.15)).mul(smoothstep(0, 0.12, h1)).mul(S.line.mul(0.8).add(0.6)).mul(S.pulse.mul(1.2).add(1));
    return invertable(S, lit.add(vec3(0.004, 0.006, 0.002)));
  })();
  return { id: 'romanesco', label: 'Romanesco', Z: 20, material, z, dispose: () => material.dispose() };
}

/** The journey, in order. Each world hands over to the next from inside itself. */
export function buildWorlds(S: Shared): World[] {
  return [
    escapeWorld(S, 'mandelbrot', 'Mandelbrot', 'mandelbrot', {
      centre: [-0.743643887, 0.131825904], span: 2.6, Z: 300, maxIt: 180,
      pal: { edge: [0.92, 0.96, 1], halo: [0.2, 1.0, 0.15], fill: [0.01, 0.02, 0.01], bg: [0.003, 0.003, 0.004], glow: 0.22, width: 0.35 },
    }),
    escapeWorld(S, 'julia', 'Julia', 'julia', {
      k: [-0.7269, 0.1889], centre: [-0.493, 0.095], span: 3.0, Z: 60, spin: 0.35, maxIt: 150,
      pal: { edge: [1, 0.88, 1], halo: [0.7, 0.25, 1.0], fill: [0.04, 0.0, 0.07], bg: [0.003, 0.0, 0.005], glow: 0.22, width: 0.35 },
    }),
    escapeWorld(S, 'ship', 'Burning Ship', 'ship', {
      centre: [-1.7621, -0.0286], span: 3.2, Z: 60, maxIt: 150,
      pal: { edge: [1, 0.88, 0.65], halo: [1.0, 0.35, 0.05], fill: [0.07, 0.01, 0.0], bg: [0.004, 0.001, 0.0], glow: 0.22, width: 0.35 },
    }),
    lyapunovWorld(S),
    cantorWorld(S),
    sierpinskiWorld(S),
    kochWorld(S),
    takagiWorld(S),
    peanoWorld(S),
    hilbertWorld(S),
    mengerWorld(S),
    fernWorld(S),
    romanescoWorld(S),
  ];
}
