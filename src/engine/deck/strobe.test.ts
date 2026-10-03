import { describe, expect, it } from 'vitest';
import { StrobeClock } from './strobe';

describe('strobe rate limit', () => {
  it.each([40, 120, 240, 480, 960, 6000])('caps %s BPM at eight flashes per second', bpm => {
    const clock = new StrobeClock();
    const flashes: number[] = [];
    let previous = 0;
    for (let i = 0; i < 5000; i++) {
      const time = i / 1000;
      const gate = clock.gate(time, time * bpm / 60, bpm, 1);
      if (gate && !previous) flashes.push(time);
      previous = gate;
    }
    expect(flashes.length).toBeGreaterThan(1);
    for (let i = 1; i < flashes.length; i++) expect(flashes[i] - flashes[i - 1]).toBeGreaterThanOrEqual(0.125 - 1e-10);
  });

  it('guards phase/tempo/amount jumps and repeated enable toggles in real seconds', () => {
    const clock = new StrobeClock();
    const flashes: number[] = [];
    let previous = 0;
    for (let i = 0; i < 1000; i++) {
      const time = i / 1000;
      if (i % 17 === 0) { clock.reset(true); previous = 0; }
      const gate = clock.gate(time, i * 8, i % 2 ? 60 : 900, i % 3 / 2);
      if (gate && !previous) flashes.push(time);
      previous = gate;
    }
    for (let i = 1; i < flashes.length; i++) expect(flashes[i] - flashes[i - 1]).toBeGreaterThanOrEqual(0.125 - 1e-10);
  });

  it('aligns flashes to beat subdivisions and rests between pulses', () => {
    const clock = new StrobeClock();
    expect(clock.gate(0, 0, 120, 1)).toBe(1);
    expect(clock.gate(0.1, 0.2, 120, 1)).toBe(0);
    expect(clock.gate(0.125, 0.25, 120, 1)).toBe(1);
    expect(clock.gate(0.2, 0.4, 120, 1)).toBe(0);
  });

  it('returns an uninterrupted image for invalid tempo and resets on backward capture seeks', () => {
    const clock = new StrobeClock();
    expect(clock.gate(5, 0, 0, 1)).toBe(1);
    expect(clock.gate(5, 0, NaN, 1)).toBe(1);
    expect(clock.gate(5, 10, 120, 0.2)).toBe(1);
    expect(clock.gate(0, 0, 120, 0.2)).toBe(1);
  });
});
