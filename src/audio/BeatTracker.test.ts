import { describe, expect, it } from 'vitest';
import { BeatTracker } from './BeatTracker';

function random(seed: number): () => number {
  return () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
}

function clicks(bpm: number, endMs: number, startMs = 137, seed = 1): number[] {
  const rng = random(seed);
  const result: number[] = [];
  for (let time = startMs; time <= endMs + 100; time += 60000 / bpm) {
    result.push(time + (rng() * 2 - 1) * 10);
  }
  return result;
}

function feed(tracker: BeatTracker, endMs: number, beats: number[], options: {
  hats?: number[];
  gain?: number;
  seed?: number;
} = {}) {
  const rng = random(options.seed ?? 17);
  let time = 0;
  let lastTime = 0;
  const estimates = [];
  while (time <= endMs) {
    let strength = 0.07 * rng();
    for (const beat of beats) strength += Math.exp(-0.5 * ((time - beat) / 12) ** 2);
    for (const hat of options.hats ?? []) strength += 0.4 * Math.exp(-0.5 * ((time - hat) / 10) ** 2);
    tracker.push(strength * (options.gain ?? 1), time);
    const estimate = tracker.estimate();
    if (estimate) estimates.push({ time, ...estimate });
    lastTime = time;
    time += 1000 / 60 + (rng() * 2 - 1) * 3;
  }
  return { estimate: tracker.estimate(), estimates, lastTime };
}

function phaseError(beatTimeMs: number, bpm: number, originMs = 137): number {
  const period = 60000 / bpm;
  return Math.abs((beatTimeMs - originMs) - Math.round((beatTimeMs - originMs) / period) * period);
}

describe('BeatTracker', () => {
  for (const bpm of [96, 128, 142]) {
    it(`tracks ${bpm} BPM clicks with onset and frame jitter`, () => {
      for (const seed of [1, 5, 19, 71]) {
        const { estimate, lastTime } = feed(new BeatTracker(), 8000, clicks(bpm, 8000, 137, seed), { seed });
        expect(estimate).not.toBeNull();
        expect(Math.abs(estimate!.bpm - bpm), `${bpm} BPM, seed ${seed}`).toBeLessThan(1);
        expect(estimate!.confidence).toBeGreaterThanOrEqual(0.4);
        expect(phaseError(estimate!.beatTimeMs, bpm)).toBeLessThan(25);
        expect(estimate!.beatTimeMs).toBeLessThanOrEqual(lastTime);
        expect(lastTime - estimate!.beatTimeMs).toBeLessThan(60000 / estimate!.bpm);
      }
    });
  }

  it('keeps the kick tempo with eighth-note hats, including a wider tempo range', () => {
    const bpm = 128;
    const beats = clicks(bpm, 8000);
    const hats = clicks(2 * bpm, 8000, 137, 4);
    for (const tracker of [new BeatTracker(), new BeatTracker({ minBpm: 50, maxBpm: 300 })]) {
      const { estimate } = feed(tracker, 8000, beats, { hats });
      expect(estimate).not.toBeNull();
      expect(Math.abs(estimate!.bpm - bpm)).toBeLessThan(1);
      expect(estimate!.confidence).toBeGreaterThanOrEqual(0.4);
      expect(phaseError(estimate!.beatTimeMs, bpm)).toBeLessThan(25);
    }
  });

  it('prefers the actual click tempo when both of its octaves are in range', () => {
    for (const bpm of [96, 128, 142]) {
      for (const seed of [1, 5, 19, 71]) {
        const tracker = new BeatTracker({ minBpm: 40, maxBpm: 300 });
        const { estimate } = feed(tracker, 8000, clicks(bpm, 8000, 137, seed), { seed });
        expect(Math.abs(estimate!.bpm - bpm), `${bpm} BPM, seed ${seed}`).toBeLessThan(1);
        expect(estimate!.confidence).toBeGreaterThanOrEqual(0.4);
      }
    }
  });

  it('follows a tempo change from 120 to 132 BPM within four seconds', () => {
    const beats = [...clicks(120, 9900), ...clicks(132, 14500, 10137, 5)];
    const { estimates } = feed(new BeatTracker(), 14500, beats);
    const before = [...estimates].reverse().find((estimate) => estimate.time < 10000)!;
    const after = [...estimates].reverse().find((estimate) => estimate.time <= 14000)!;
    expect(Math.abs(before.bpm - 120)).toBeLessThan(1);
    expect(Math.abs(after.bpm - 132)).toBeLessThan(1);
    expect(after.confidence).toBeGreaterThanOrEqual(0.4);
    expect(phaseError(after.beatTimeMs, 132, 10137)).toBeLessThan(25);
  });

  it('rejects silence and uncorrelated noise throughout acquisition', () => {
    for (const noise of [false, true]) {
      const tracker = new BeatTracker();
      const rng = random(33);
      for (let time = 0; time <= 16000; time += 1000 / 60) {
        tracker.push(noise ? rng() : 0, time);
        expect(tracker.estimate()?.confidence ?? 0).toBeLessThan(0.2);
      }
    }
  });

  it('has gain-independent estimates for unnormalized onset strengths', () => {
    for (const gain of [1e-300, 1e-6, 1e6, 1e300]) {
      const { estimate } = feed(new BeatTracker(), 8000, clicks(96, 8000), { gain });
      expect(Math.abs(estimate!.bpm - 96)).toBeLessThan(1);
      expect(estimate!.confidence).toBeGreaterThanOrEqual(0.4);
    }
  });

  it('releases confidence when a previously tracked signal becomes silent or noisy', () => {
    for (const noise of [false, true]) {
      const tracker = new BeatTracker();
      const { lastTime } = feed(tracker, 8000, clicks(128, 8000));
      const rng = random(11);
      for (let time = lastTime + 17; time < lastTime + 2000; time += 17) {
        tracker.push(noise ? rng() : 0, time);
        tracker.estimate();
      }
      expect(tracker.estimate()?.confidence ?? 0).toBeLessThan(0.2);
    }
  });

  it('can acquire from pushed history without previous estimate calls', () => {
    const tracker = new BeatTracker();
    const beats = clicks(128, 8000);
    for (let time = 0; time <= 8000; time += 1000 / 60) {
      let strength = 0;
      for (const beat of beats) strength += Math.exp(-0.5 * ((time - beat) / 12) ** 2);
      tracker.push(strength, time);
    }
    const estimate = tracker.estimate()!;
    expect(Math.abs(estimate.bpm - 128)).toBeLessThan(1);
    expect(estimate.confidence).toBeGreaterThanOrEqual(0.4);
  });

  it('resets acquisition and ignores invalid or out-of-order samples', () => {
    const tracker = new BeatTracker();
    const { estimate } = feed(tracker, 8000, clicks(128, 8000));
    tracker.push(NaN, 9000);
    tracker.push(Infinity, 9000);
    tracker.push(1, NaN);
    tracker.push(1, -1);
    expect(tracker.estimate()).toEqual(estimate);
    tracker.reset();
    expect(tracker.estimate()).toBeNull();
    tracker.push(1, 0);
    expect(tracker.estimate()).toBeNull();
  });
});
