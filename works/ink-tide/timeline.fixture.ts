import { SILENT } from '../../src/engine/types';
import type { LiveSignals, Signals } from '../../src/engine/types';

export const TIMELINE_DROPS = [30, 44, 47];
export const TIMELINE_BPM = 128;

/** Matches the 16-second, 30 Hz offline capture. */
export function offlineSignals(time: number): Signals {
  const beats = time * TIMELINE_BPM / 60;
  const beat = beats % 1;
  const building = time >= 4 && time < 10;
  const kick = building ? 0 : Math.exp(-beat * 60 / TIMELINE_BPM / 0.055);
  return { ...SILENT, time, dt: 1 / 30, frame: Math.round(time * 30),
    bpm: TIMELINE_BPM, beats, beat, bar: (beats % 4) / 4,
    kick, onset: kick, low: 0.2 + 0.55 * kick, mid: 0.28, level: 0.5,
    high: building ? 0.2 + (time - 4) * 0.1 : 0.3,
    tension: building ? (time - 4) / 6 : 0,
    drop: time >= 10 ? Math.exp(-(time - 10) / 2.2) : 0 };
}

/** A musical drop, then two manual drops three seconds apart. */
export function timelineSignals(time: number): LiveSignals {
  const beats = time * TIMELINE_BPM / 60;
  const beat = beats % 1;
  const building = time >= 20 && time < 30;
  const kick = building ? 0 : Math.exp(-beat * 60 / TIMELINE_BPM / 0.055);
  const lastDrop = TIMELINE_DROPS.filter(t => time >= t).at(-1);
  return {
    ...SILENT, bpm: TIMELINE_BPM, beats, beat, bar: (beats % 4) / 4,
    kick, onset: kick, low: 0.2 + 0.55 * kick, mid: 0.28,
    high: building ? 0.2 + (time - 20) * 0.06 : 0.3, level: 0.5,
    tension: building ? Math.min(1, (time - 20) / 7) : 0,
    drop: lastDrop === undefined ? 0 : Math.exp(-(time - lastDrop) / 2.2),
  };
}
