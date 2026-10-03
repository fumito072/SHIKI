import type { BeatEstimate } from '../audio/beat';

export type ClockSource = 'internal' | 'tap' | 'audio';

export interface ClockState {
  bpm: number;
  /** Continuous beat count. */
  beats: number;
  /** 0..1 phase within the beat. */
  beat: number;
  /** 0..1 phase within the 4-beat bar. */
  bar: number;
  source: ClockSource;
  confidence: number;
}

/**
 * Musical time. Beats are counted from `anchor` (ms). Manual input (tap, nudge,
 * downbeat) always wins; audio following only steers gently while confident.
 */
export class Clock {
  bpm = 120;
  source: ClockSource = 'internal';
  confidence = 1;
  /** Audio following is only used while this is true (the user picked "audio"). */
  follow = false;

  private anchor = performance.now();
  private taps: number[] = [];

  get beatMs(): number {
    return 60000 / this.bpm;
  }

  beatsAt(now: number): number {
    return (now - this.anchor) / this.beatMs;
  }

  state(now = performance.now()): ClockState {
    const beats = this.beatsAt(now);
    return {
      bpm: this.bpm,
      beats,
      beat: fract(beats),
      bar: fract(beats / 4),
      source: this.source,
      confidence: this.confidence,
    };
  }

  /** Change tempo while keeping the current beat position continuous. */
  setBpm(bpm: number, now = performance.now()): void {
    const beats = this.beatsAt(now);
    this.bpm = clamp(bpm, 40, 240);
    this.anchor = now - beats * this.beatMs;
  }

  tap(now = performance.now()): void {
    const last = this.taps[this.taps.length - 1];
    if (last !== undefined && now - last > 2000) this.taps = [];
    this.taps.push(now);
    if (this.taps.length > 8) this.taps.shift();
    if (this.taps.length >= 2) {
      const intervals = this.taps.slice(1).map((t, i) => t - this.taps[i]).sort((a, b) => a - b);
      const median = intervals[Math.floor(intervals.length / 2)];
      this.setBpm(60000 / median, now);
    }
    // The tap lands on a beat.
    this.anchor = now - Math.round(this.beatsAt(now)) * this.beatMs;
    this.source = 'tap';
    this.follow = false;
    this.confidence = 1;
  }

  /** Shift the phase by `ms` (positive = later). */
  nudge(ms: number): void {
    this.anchor += ms;
  }

  /** Make `now` the first beat of a bar. */
  downbeat(now = performance.now()): void {
    const bars = Math.round(this.beatsAt(now) / 4);
    this.anchor = now - bars * 4 * this.beatMs;
  }

  /** Steer toward an audio beat estimate (phase-locked loop). */
  followAudio(est: BeatEstimate | null, now = performance.now()): void {
    if (!this.follow) return;
    this.confidence = est?.confidence ?? 0;
    if (!est || est.confidence < 0.4) return;
    this.source = 'audio';
    if (Math.abs(est.bpm - this.bpm) > 0.05) this.setBpm(this.bpm + (est.bpm - this.bpm) * 0.08, now);
    // Phase error in beats, wrapped to [-0.5, 0.5).
    const err = fract(this.beatsAt(est.beatTimeMs) + 0.5) - 0.5;
    this.anchor += err * this.beatMs * 0.1;
  }
}

function fract(x: number): number {
  return x - Math.floor(x);
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}
