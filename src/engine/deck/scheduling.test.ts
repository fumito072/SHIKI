import { describe, expect, it } from 'vitest';
import { TakeScheduler, nextBoundary, scheduleTake } from './scheduling';
import type { Quantize, TakeOptions } from './scheduling';

const dissolve: TakeOptions = { transition: 'dissolve', beats: 4, quantize: 'beat' };

describe('beat-domain scheduling', () => {
  it.each<[Quantize, number, number]>([
    ['now', 7.25, 7.25], ['beat', 7.25, 8], ['beat', 8, 9],
    ['bar', 7.25, 8], ['bar', 8, 12], ['phrase16', 17.2, 32],
    ['phrase16', 16, 32], ['phrase32', 32, 64], ['phrase32', 31.999, 32],
    ['bar', -0.2, 0], ['beat', 7.99999999, 8], ['beat', 8.00000001, 9],
  ])('aligns %s from %s to %s', (quantize, beat, expected) => {
    expect(nextBoundary(beat, quantize)).toBe(expected);
  });

  it('holds the outgoing deck before start and settles exactly at completion', () => {
    const s = new TakeScheduler();
    s.request(3.25, dissolve);
    expect(s.pending).toMatchObject({ startBeat: 4, endBeat: 8, from: 'A', to: 'B' });
    s.advance(3.9);
    expect([s.mix, s.progress, s.onAir]).toEqual([0, 0, 'A']);
    s.advance(4);
    expect(s.pending).toBeNull();
    expect(s.active).not.toBeNull();
    s.advance(6);
    expect([s.mix, s.progress, s.onAir]).toEqual([0.5, 0.5, 'A']);
    s.advance(8);
    expect([s.mix, s.progress, s.onAir, s.active]).toEqual([1, 1, 'B', null]);
    s.request(8.5, dissolve);
    expect(s.progress).toBe(0);
    s.advance(10);
    expect(s.mix).toBe(0.75);
  });

  it('queues a mid-transition take at the first aligned boundary at or after completion', () => {
    const s = new TakeScheduler();
    s.request(0.25, { ...dissolve, beats: 5 });
    s.advance(3);
    s.request(3, { ...dissolve, quantize: 'bar' });
    expect(s.active).toMatchObject({ startBeat: 1, endBeat: 6, from: 'A', to: 'B' });
    expect(s.pending).toMatchObject({ startBeat: 8, endBeat: 12, from: 'B', to: 'A' });
    s.advance(6);
    expect([s.onAir, s.mix]).toEqual(['B', 1]);
    s.advance(10);
    expect([s.onAir, s.mix, s.progress]).toEqual(['B', 0.5, 0.5]);
    s.advance(12);
    expect([s.onAir, s.mix]).toEqual(['A', 0]);
  });

  it('allows a queued now take to start exactly when the active take finishes', () => {
    const s = new TakeScheduler();
    s.request(4, { ...dissolve, quantize: 'now' });
    s.request(5, { ...dissolve, quantize: 'now' });
    expect(s.pending?.startBeat).toBe(8);
    s.advance(8);
    expect(s.active).toMatchObject({ from: 'B', to: 'A', startBeat: 8 });
    expect([s.progress, s.mix, s.onAir]).toEqual([0, 1, 'B']);
  });

  it('aligns a queued phrase to the clock origin, including an exact end boundary', () => {
    const s = new TakeScheduler();
    s.request(0, { ...dissolve, beats: 32, quantize: 'now' });
    s.request(3.25, { ...dissolve, quantize: 'phrase16' });
    expect(s.pending?.startBeat).toBe(32);
  });

  it('replaces only the reservation on repeated requests and handles frame skips', () => {
    const s = new TakeScheduler();
    s.request(0, { ...dissolve, quantize: 'now' });
    s.request(1, { ...dissolve, quantize: 'phrase32' });
    s.request(2, { ...dissolve, beats: 2, quantize: 'now' });
    expect(s.active?.endBeat).toBe(4);
    expect(s.pending?.endBeat).toBe(6);
    s.advance(40);
    expect([s.active, s.pending, s.onAir, s.mix]).toEqual([null, null, 'A', 0]);
  });

  it('cuts at the quantized start and treats zero-duration transitions as cuts', () => {
    const s = new TakeScheduler();
    s.request(0.5, { transition: 'cut', beats: 100, quantize: 'bar' });
    s.advance(3.999);
    expect(s.mix).toBe(0);
    s.advance(4);
    expect([s.mix, s.onAir, s.active]).toEqual([1, 'B', null]);
    s.request(4, { ...dissolve, beats: 0, quantize: 'now' });
    expect([s.mix, s.onAir]).toEqual([0, 'A']);
  });

  it('rejects invalid input without changing the scheduler', () => {
    const s = new TakeScheduler();
    s.request(1.5, dissolve);
    const pending = s.pending;
    for (const beats of [-1, NaN, Infinity]) expect(() => s.request(20, { ...dissolve, beats })).toThrow();
    expect(s.pending).toBe(pending);
    expect(s.active).toBeNull();
    expect(() => nextBoundary(Infinity, 'beat')).toThrow();
    expect(() => scheduleTake(0, 'A', dissolve, Infinity)).toThrow();
  });

  it('cancels both takes for a manual cut', () => {
    const s = new TakeScheduler();
    s.request(0, { ...dissolve, quantize: 'now' });
    s.request(1, dissolve);
    s.cutTo('B');
    s.advance(100);
    expect([s.active, s.pending, s.onAir, s.mix, s.progress]).toEqual([null, null, 'B', 1, 0]);
  });
});
