// The standard signals as TSL uniform nodes — the WebGPU counterpart of stdUniforms() in ../glsl.ts.
// Each instrument instance owns one set (decks render different works with different macros), and calls
// updateSignals() at the top of render().
import { uniform } from 'three/tsl';
import type { Frame } from '../types';
import { MAX_MACROS } from '../types';

export function signalUniforms() {
  return {
    time: uniform(0),
    dt: uniform(0),
    frame: uniform(0),
    bpm: uniform(120),
    beat: uniform(0),
    bar: uniform(0),
    beats: uniform(0),
    low: uniform(0),
    mid: uniform(0),
    high: uniform(0),
    level: uniform(0),
    onset: uniform(0),
    kick: uniform(0),
    tension: uniform(0),
    drop: uniform(0),
    width: uniform(1),
    height: uniform(1),
    /** Effective macros (knob + modulation), 0..1, in manifest order. */
    macro: Array.from({ length: MAX_MACROS }, () => uniform(0)),
  };
}

export type SignalUniforms = ReturnType<typeof signalUniforms>;

export function updateSignals(u: SignalUniforms, f: Frame): void {
  const s = f.signals;
  u.time.value = s.time;
  u.dt.value = s.dt;
  u.frame.value = s.frame;
  u.bpm.value = s.bpm;
  u.beat.value = s.beat;
  u.bar.value = s.bar;
  u.beats.value = s.beats;
  u.low.value = s.low;
  u.mid.value = s.mid;
  u.high.value = s.high;
  u.level.value = s.level;
  u.onset.value = s.onset;
  u.kick.value = s.kick;
  u.tension.value = s.tension;
  u.drop.value = s.drop;
  u.width.value = f.width;
  u.height.value = f.height;
  for (let i = 0; i < MAX_MACROS; i++) u.macro[i].value = f.macros[i] ?? 0;
}
