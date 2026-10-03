import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Analyzer } from './Analyzer';
import { Choreography } from './Choreography';

// Runs the real analyzer + choreography over the structured test track (npm run gen:testtrack):
// groove 0–15 s, breakdown 15–22.5 s, build 22.5–30 s, drop at 30 s.
const WAV = 'public/test/testtrack-128.wav';
const N = 2048;

function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let k = 0; k < len / 2; k++) {
        const wr = Math.cos(ang * k);
        const wi = Math.sin(ang * k);
        const a = i + k;
        const b = a + len / 2;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

/** Mimics AnalyserNode.getFloatFrequencyData (Blackman window, no smoothing) at 60 frames per second. */
function analyse(): { t: number; tension: number; drop: number; kick: number }[] {
  const buf = readFileSync(WAV);
  const sr = buf.readUInt32LE(24);
  const n = buf.readUInt32LE(40) / 2;
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = buf.readInt16LE(44 + i * 2) / 32768;
  const win = Float64Array.from({ length: N }, (_, i) => 0.42 - 0.5 * Math.cos((2 * Math.PI * i) / N) + 0.08 * Math.cos((4 * Math.PI * i) / N));
  const re = new Float64Array(N);
  const im = new Float64Array(N);
  const db = new Float32Array(N / 2);
  const an = new Analyzer(N / 2, sr);
  const ch = new Choreography();
  const dt = 1 / 60;
  const out: { t: number; tension: number; drop: number; kick: number }[] = [];
  for (let end = N; end < n; end += Math.round(sr * dt)) {
    for (let i = 0; i < N; i++) {
      re[i] = x[end - N + i] * win[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) {
      const m = Math.hypot(re[k], im[k]) / N;
      db[k] = m > 0 ? 20 * Math.log10(m) : -Infinity;
    }
    const f = an.process(db, dt);
    const c = ch.step(f, dt);
    out.push({ t: end / sr, tension: c.tension, drop: c.drop, kick: f.kick });
  }
  return out;
}

function hits(log: { t: number; kick: number }[], from: number, to: number): number {
  let count = 0;
  for (let i = 1; i < log.length; i++) {
    if (log[i].t < from || log[i].t > to) continue;
    if (log[i].kick > 0.95 && log[i - 1].kick <= 0.95) count++;
  }
  return count;
}

describe.skipIf(!existsSync(WAV))('choreography on the structured test track', () => {
  const log = existsSync(WAV) ? analyse() : [];
  const at = (t: number) => log.find((r) => r.t >= t)!;

  it('detects kicks in the groove (128 BPM ≈ 2.13 per second)', () => {
    expect(hits(log, 3, 14)).toBeGreaterThan(18);
  });

  it('sees no kicks through the breakdown and build', () => {
    expect(hits(log, 16, 29.7)).toBeLessThan(3);
  });

  it('builds tension before the drop', () => {
    expect(at(29.5).tension).toBeGreaterThan(0.4);
  });

  it('fires the drop when the kick returns at 30 s, and not before', () => {
    expect(log.some((r) => r.t < 29.5 && r.drop > 0.5)).toBe(false);
    const first = log.find((r) => r.t > 25 && r.drop > 0.9);
    expect(first?.t).toBeGreaterThan(29.8);
    expect(first?.t).toBeLessThan(30.8);
  });

  it('finds kicks again after the drop', () => {
    expect(hits(log, 31, 40)).toBeGreaterThan(14);
  });
});
