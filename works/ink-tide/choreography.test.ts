import { describe, expect, it } from 'vitest';
import { SILENT } from '../../src/engine/types';
import type { LiveSignals } from '../../src/engine/types';
import { offlineSignals, TIMELINE_BPM, TIMELINE_DROPS, timelineSignals } from './timeline.fixture';
import {
  captureHistory, elasticStroke, HISTORY_FRAMES, historyPair, initialDance, initialHistory, simulationSize, simulationSteps, stepDance,
} from './choreography';

describe('liquid choreography', () => {
  it('stretches, recoils, and settles within about one beat', () => {
    expect(elasticStroke(0)).toBe(0);
    expect(elasticStroke(0.15)).toBeGreaterThan(1);
    expect(elasticStroke(0.6)).toBeLessThan(-0.1);
    expect(Math.abs(elasticStroke(1))).toBeLessThan(0.02);
    expect(elasticStroke(1.25)).toBe(0);
    expect(elasticStroke(-1)).toBe(0);
  });

  it('does not schedule motion from amplitude or a silent metronome', () => {
    let state = initialDance();
    for (let i = 0; i < 1200; i++) {
      const beats = i / 30;
      const dance = stepDance(state, { ...SILENT, beats, beat: beats % 1, low: 1, high: 1 }, 1 / 60, 1);
      expect(dance.stroke).toBe(0);
      state = dance.state;
    }
    expect(state.low).toBeCloseTo(1, 4);
  });

  it('starts before the next beat and anticipates only once per beat', () => {
    let state = stepDance(initialDance(), { ...SILENT, kick: 1 }, 1 / 60, 0.5).state;
    state = { ...state, kickAge: 0.9, previousKick: 0 };
    let dance = stepDance(state, { ...SILENT, beat: 0.86, beats: 0.86 }, 1 / 60, 0.5);
    expect(dance.state.anticipatedBeat).toBe(1);
    expect(dance.state.anticipateAge).toBe(0);
    dance = stepDance(dance.state, { ...SILENT, beat: 0.9, beats: 0.9 }, 1 / 60, 0.5);
    expect(dance.state.anticipateAge).toBeGreaterThan(0);
    expect(dance.stroke).toBeGreaterThan(0);
    dance = stepDance({ ...dance.state, kickAge: 4 }, { ...SILENT, beat: 0.9, beats: 4.9 }, 1 / 60, 0.5);
    expect(dance.state.anticipatedBeat).toBe(1);
  });

  it('triggers on kick edges without repeatedly firing a held envelope', () => {
    let dance = stepDance(initialDance(), { ...SILENT, kick: 1 }, 1 / 60, 0.5);
    for (let i = 0; i < 60; i++) dance = stepDance(dance.state, { ...SILENT, kick: 1 }, 1 / 60, 0.5);
    expect(dance.state.kickAge).toBeCloseTo(2);
    dance = stepDance(dance.state, SILENT, 1 / 60, 0.5);
    dance = stepDance(dance.state, { ...SILENT, kick: 1, beats: 2 }, 1 / 60, 0.5);
    expect(dance.state.kickAge).toBe(0);
    expect(dance.state.arc).toBe(2);
  });

  it('smooths gathering and bass independently of frame rate', () => {
    const run = (fps: number) => {
      let state = initialDance();
      for (let i = 0; i < fps * 3; i++) state = stepDance(state, { ...SILENT, tension: 1, low: 1 }, 1 / fps, 0.65).state;
      return state;
    };
    const a = run(30), b = run(120);
    expect(a.gather).toBeGreaterThan(0.98);
    expect(a.gather).toBeCloseTo(b.gather, 10);
    expect(a.low).toBeCloseTo(b.low, 10);
    const frozen = stepDance(a, SILENT, 0, 0.65);
    expect(frozen.state.gather).toBe(a.gather);
    expect(frozen.state.low).toBe(a.low);
  });

  it.each([80, 128, 180])('reverses, gathers, bursts, and restores the boundary at %i BPM', bpm => {
    let dance = stepDance(initialDance(), { ...SILENT, bpm, drop: 1 }, 1 / 120, 0.65);
    expect(dance.dropStarted).toBe(true);
    let bursts = 0, lastReplay = 0, collapseSeen = false, floodSeen = false;
    for (let i = 0; i < Math.ceil(10 * 60 / bpm * 120); i++) {
      dance = stepDance(dance.state, { ...SILENT, bpm, drop: Math.exp(-i / 120 / 2.2) }, 1 / 120, 0.65);
      expect(dance.dropStarted).toBe(false);
      if (dance.burstStarted) {
        bursts++;
        expect(dance.state.dropAge).toBeGreaterThanOrEqual(4);
        expect(dance.state.dropAge).toBeLessThan(4.03);
      }
      if (dance.replay >= 0) {
        expect(dance.replay).toBeGreaterThanOrEqual(lastReplay);
        lastReplay = dance.replay;
        expect(dance.burst).toBe(0);
        expect(dance.stroke).toBe(0);
      }
      if (dance.collapse > 0.95) collapseSeen = true;
      if (dance.burst > 0.2 && dance.flood === 1) floodSeen = true;
    }
    expect(lastReplay).toBe(1);
    expect(collapseSeen).toBe(true);
    expect(floodSeen).toBe(true);
    expect(bursts).toBe(1);
    expect(dance.replay).toBe(-1);
    expect(dance.flood).toBe(0);
    expect(dance.state.dropAge).toBe(-1);
  });

  it('allows a new manual DROP during the previous envelope', () => {
    let dance = stepDance(initialDance(), { ...SILENT, drop: 1 }, 0.01, 1);
    dance = stepDance(dance.state, { ...SILENT, drop: 0.82 }, 0.1, 1);
    dance = stepDance(dance.state, { ...SILENT, drop: 1 }, 0.01, 1);
    expect(dance.dropStarted).toBe(true);
    expect(dance.state.dropAge).toBe(0);
  });

  it.each([80, 128, 180])('re-blooms behind the burst within one second at %i BPM', bpm => {
    let state = initialDance(), burstTime = -1, peakTime = -1;
    for (let i = 0; i < 12 * 30; i++) {
      const time = i / 30;
      const dance = stepDance(state, { ...SILENT, bpm, drop: Math.exp(-time / 2.2) }, 1 / 30, 0.65);
      if (dance.burstStarted) burstTime = time;
      if (dance.bloom > 0.99 && peakTime < 0) peakTime = time;
      if (burstTime < 0) expect(dance.bloom).toBe(0);
      if (dance.bloom > 0) expect(dance.replay).toBe(-1);
      state = dance.state;
    }
    expect(burstTime).toBeGreaterThan(0);
    expect(peakTime - burstTime).toBeGreaterThan(0.7);
    expect(peakTime - burstTime).toBeLessThan(1);
    expect(state.bloomAge).toBe(-1);
  });

  it('opens the left during the offline burst while the right replenishes, then restores stillness', () => {
    let state = initialDance(), starts = 0, bursts = 0;
    let peakGather = 0, overlappingBloom = false;
    for (let i = 0; i < 16 * 30; i++) {
      const dance = stepDance(state, offlineSignals(i / 30), 1 / 30, 0.65);
      if (dance.dropStarted) starts++;
      if (dance.burstStarted) bursts++;
      if (dance.flood === 1 && dance.bloom > 0.8) overlappingBloom = true;
      peakGather = Math.max(peakGather, dance.gather);
      state = dance.state;
    }
    expect(starts).toBe(1);
    expect(bursts).toBe(1);
    expect(peakGather).toBeGreaterThan(0.98);
    expect(overlappingBloom).toBe(true);
    expect(state.dropAge).toBe(-1);
    expect(state.bloomAge).toBe(-1);
  });

  it.each([24, 60, 120])('resumes simulation after every DROP in a 60-second live timeline at %i Hz', fps => {
    let state = initialDance();
    let replayFrames = 0, longestReplay = 0, bursts = 0, peakGather = 0;
    const starts: number[] = [], resumes: number[] = [];
    let pendingResume = false;
    for (let i = 0; i < 60 * fps; i++) {
      const time = i / fps;
      const dance = stepDance(state, timelineSignals(time), 1 / fps, 0.65);
      if (dance.dropStarted) {
        starts.push(time);
        pendingResume = true;
      }
      if (dance.burstStarted) bursts++;
      if (dance.replay >= 0) replayFrames++;
      else {
        longestReplay = Math.max(longestReplay, replayFrames);
        replayFrames = 0;
        expect(simulationSteps(1 / fps)).toBeGreaterThan(0);
        if (pendingResume) {
          resumes.push(time);
          pendingResume = false;
        }
      }
      peakGather = Math.max(peakGather, dance.gather);
      state = dance.state;
    }
    expect(starts).toEqual(TIMELINE_DROPS);
    expect(bursts).toBe(3);
    expect(resumes).toHaveLength(3);
    for (let i = 0; i < starts.length; i++) {
      expect(resumes[i] - starts[i]).toBeCloseTo(4 * 60 / TIMELINE_BPM, 1);
      expect(resumes[i] - starts[i]).toBeLessThan(2);
    }
    expect(longestReplay / fps).toBeLessThan(2);
    expect(peakGather).toBeGreaterThan(0.98);
    expect(pendingResume).toBe(false);
    expect(state.dropAge).toBe(-1);
  });

  it('cannot restart replay forever from noise around the DROP threshold', () => {
    let dance = stepDance(initialDance(), { ...SILENT, bpm: 128, drop: 1 }, 1 / 60, 0.65);
    let bursts = 0;
    for (let i = 0; i < 360; i++) {
      dance = stepDance(dance.state, { ...SILENT, bpm: 128, drop: i % 2 ? 0.72 : 0.69 }, 1 / 60, 0.65);
      expect(dance.dropStarted).toBe(false);
      if (dance.burstStarted) bursts++;
      if (i >= 120) expect(dance.replay).toBe(-1);
    }
    expect(bursts).toBe(1);
    expect(dance.state.dropAge).toBe(-1);
  });

  it('does not consume signal edges or progress during a zero-dt trial or pause', () => {
    const old = initialDance();
    const signals = { ...SILENT, drop: 1, kick: 1, tension: 1 };
    const trial = stepDance(old, signals, 0, 0.65);
    expect(trial.state).toEqual(old);
    expect(trial.dropStarted).toBe(false);
    const first = stepDance(trial.state, signals, 1 / 60, 0.65);
    expect(first.dropStarted).toBe(true);
    expect(first.state.kickAge).toBe(0);
    expect(stepDance(first.state, SILENT, 0, 0.65).state).toEqual(first.state);
  });

  it('survives a structured groove, build, and bar-17 drop without repeated drops', () => {
    let state = initialDance(), dropCount = 0, anticipations = 0, peakGather = 0;
    const fps = 60, bpm = 128;
    for (let i = 0; i < Math.ceil(70 * 60 / bpm * fps); i++) {
      const beats = i / fps * bpm / 60;
      const build = beats >= 48 && beats < 64;
      const phase = beats % 1;
      const signals: LiveSignals = { ...SILENT, bpm, beats, beat: phase,
        kick: build ? 0 : phase < 0.07 ? 1 : 0,
        tension: build ? Math.min(1, (beats - 48) / 12) : 0,
        drop: beats >= 64 ? Math.exp(-(beats - 64) * 60 / bpm / 2.2) : 0 };
      const dance = stepDance(state, signals, 1 / fps, 0.65);
      if (dance.dropStarted) dropCount++;
      if (dance.state.anticipatedBeat !== state.anticipatedBeat) anticipations++;
      peakGather = Math.max(peakGather, dance.gather);
      state = dance.state;
    }
    expect(dropCount).toBe(1);
    expect(anticipations).toBeGreaterThan(40);
    expect(peakGather).toBeGreaterThan(0.97);
  });
});

describe('GPU budget and recorded time', () => {
  it('keeps normal 60 Hz timing jitter within one simulation step', () => {
    expect(simulationSteps(0)).toBe(0);
    expect(simulationSteps(1 / 60)).toBe(1);
    expect(simulationSteps(0.018)).toBe(1);
    expect(simulationSteps(1 / 30)).toBe(2);
    expect(simulationSteps(0.05)).toBe(2);
    expect(simulationSteps(5)).toBe(2);
  });

  it('caps simulation size in landscape, portrait, and tiny windows', () => {
    expect(simulationSize(1920, 1080)).toEqual([480, 270]);
    expect(simulationSize(3840, 2160)).toEqual([480, 270]);
    expect(simulationSize(1080, 1920)).toEqual([152, 270]);
    expect(simulationSize(1, 1)).toEqual([1, 1]);
  });

  it('records four beats, wraps safely, and interpolates newest to oldest', () => {
    let state = initialHistory();
    for (let i = 0; i < 40; i++) {
      const capture = captureHistory(state, i * 0.25);
      expect(capture.slot).not.toBeNull();
      state = capture.state;
      expect(captureHistory(state, i * 0.25 + 0.1).slot).toBeNull();
    }
    expect(state.count).toBe(HISTORY_FRAMES);
    expect(historyPair(state, 0).a).toBe(state.newest);
    expect(historyPair(state, 1).a).toBe((state.newest + 1) % HISTORY_FRAMES);
    const seam = historyPair({ newest: 0, count: 17, nextBeat: 0 }, 0.5 / 16);
    expect(seam).toEqual({ a: 0, b: 16, mix: 0.5 });
  });

  it('never reads an uncaptured slot when DROP arrives immediately', () => {
    const state = captureHistory(initialHistory(), 0).state;
    for (const progress of [-1, 0, 0.6, 1, 2]) expect(historyPair(state, progress)).toEqual({ a: 0, b: 0, mix: 0 });
  });

  it('keeps recording on the quarter-beat grid when frames arrive late', () => {
    let state = captureHistory(initialHistory(), 0).state;
    state = captureHistory(state, 0.29).state;
    expect(state.nextBeat).toBe(0.5);
    state = captureHistory(state, 0.54).state;
    expect(state.nextBeat).toBe(0.75);
  });
});
