import { describe, expect, it } from 'vitest';
import { Director } from './director';
import type { Signals } from '../../types';
import { SILENT } from '../../types';

const opts = { shots: 7, styles: 4, impactShot: 5, buildShot: 6, calmShots: [0, 4], impactStyles: [0, 1, 2], seed: 3 };
const dt = 1 / 60;
const bpm = 128;

/** Steps the director through `seconds` of a scripted section, returning the states. */
function run(d: Director, from: number, seconds: number, f: (t: number, beats: number) => Partial<Signals>) {
  const out: { t: number; beats: number; shot: number; style: number; phase: string; cut: number; flash: number }[] = [];
  for (let t = from; t < from + seconds; t += dt) {
    const beats = (t * bpm) / 60;
    const st = d.update({ ...SILENT, time: t, dt, frame: 0, bpm, beats, beat: beats % 1, bar: (beats / 4) % 1, ...f(t, beats) });
    out.push({ t, beats, shot: st.shot, style: st.style, phase: st.phase, cut: st.cut, flash: st.flash });
  }
  return out;
}

const groove = (_t: number, beats: number) => ({ level: 0.7, low: 0.7, kick: Math.exp(-((beats % 1) * 60) / bpm / 0.1) });

describe('Director', () => {
  it('cuts only on bar boundaries while grooving, more often with more energy', () => {
    const d = new Director(opts);
    const log = run(d, 0, 20, groove);
    const cuts = log.filter((r, i) => i > 0 && r.cut !== log[i - 1].cut);
    expect(cuts.length).toBeGreaterThan(5);
    for (const c of cuts) expect(Math.abs(c.beats / 4 - Math.round(c.beats / 4))).toBeLessThan(0.02);
    expect(log.some((r) => r.shot === opts.buildShot)).toBe(false);
  });

  it('holds the build shot through a build', () => {
    const d = new Director(opts);
    run(d, 0, 4, groove);
    const build = run(d, 4, 8, () => ({ level: 0.4, low: 0.2, kick: 0, tension: 0.6 }));
    const after = build.filter((r) => r.t > 6);
    expect(after.every((r) => r.shot === opts.buildShot && r.phase === 'build')).toBe(true);
  });

  it('cuts to the impact shot with a flash and a new look on the drop', () => {
    const d = new Director(opts);
    run(d, 0, 4, groove);
    const before = d.current.style;
    const log = run(d, 4, 3, (t) => ({ level: 0.8, low: 0.8, kick: 1, drop: t > 5 ? Math.exp(-(t - 5) / 2.2) : 0 }));
    const hit = log.find((r) => r.t > 5);
    expect(hit?.shot).toBe(opts.impactShot);
    expect(hit?.phase).toBe('impact');
    expect(hit?.flash).toBeGreaterThan(0.9);
    expect(hit?.style).not.toBe(before);
  });

  it('is deterministic for a seed', () => {
    const a = run(new Director(opts), 0, 12, groove).map((r) => r.shot).join();
    const b = run(new Director(opts), 0, 12, groove).map((r) => r.shot).join();
    expect(a).toBe(b);
  });
});
