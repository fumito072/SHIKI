import type { LiveSignals } from '../../src/engine/types';

const clamp = (x: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, x));
const follow = (a: number, b: number, dt: number, seconds: number) => a + (b - a) * (1 - Math.exp(-dt / seconds));

export function simulationSize(width: number, height: number): [number, number] {
  const w = Math.max(1, Math.floor(width)), h = Math.max(1, Math.floor(height));
  const scale = Math.min(0.25, 480 / w, 270 / h);
  return [Math.max(1, Math.ceil(w * scale)), Math.max(1, Math.ceil(h * scale))];
}

export const PRESSURE_ITERATIONS = 12;

export function simulationSteps(seconds: number): number {
  return seconds <= 0 ? 0 : Math.ceil(clamp(seconds, 0, 0.05) / 0.025 - 1e-9);
}

/** Signed force: stretch, recoil, then settle in roughly one beat. */
export function elasticStroke(age: number): number {
  return age < 0 || age >= 1.25 ? 0 : 3.2 * Math.exp(-5.2 * age) * Math.sin(8.2 * age);
}

export interface DanceState {
  elapsed: number;
  kickAge: number;
  anticipateAge: number;
  anticipatedBeat: number;
  previousKick: number;
  previousDrop: number;
  dropArmed: boolean;
  dropAge: number;
  bloomAge: number;
  arc: number;
  low: number;
  gather: number;
}

export function initialDance(): DanceState {
  return {
    elapsed: 0, kickAge: 100, anticipateAge: 100, anticipatedBeat: -Infinity,
    previousKick: 0, previousDrop: 0, dropArmed: true, dropAge: -1, bloomAge: -1, arc: 0, low: 0, gather: 0,
  };
}

export interface Dance {
  state: DanceState;
  stroke: number;
  gather: number;
  low: number;
  replay: number;
  collapse: number;
  burst: number;
  flood: number;
  bloom: number;
  dropStarted: boolean;
  burstStarted: boolean;
}

/** Only signal edges schedule events; envelopes never vibrate the geometry. */
export function stepDance(old: DanceState, signals: LiveSignals, seconds: number, tensionGain: number): Dance {
  const dt = clamp(seconds, 0, 0.1);
  const beats = dt * clamp(signals.bpm, 40, 240) / 60;
  const state = { ...old, elapsed: old.elapsed + beats, kickAge: old.kickAge + beats,
    anticipateAge: old.anticipateAge + beats };
  const kick = dt > 0 && signals.kick > 0.6 && (old.previousKick <= 0.6 || signals.kick - old.previousKick > 0.25)
    && state.kickAge > 0.3;
  // Rearm only after release; threshold noise cannot restart the replay.
  const dropStarted = dt > 0 && signals.drop > 0.7 && (old.dropArmed || signals.drop - old.previousDrop > 0.15);
  if (dt > 0) {
    state.previousKick = signals.kick;
    state.previousDrop = signals.drop;
    state.dropArmed = signals.drop < 0.35 || (old.dropArmed && !dropStarted);
  }
  if (kick) {
    state.kickAge = 0;
    state.arc = ((Math.floor(signals.beats) % 3) + 3) % 3;
  }
  const nextBeat = Math.floor(signals.beats) + 1;
  if (dt > 0 && signals.beat > 0.85 && state.kickAge < 3 && nextBeat !== state.anticipatedBeat && old.dropAge < 0) {
    state.anticipatedBeat = nextBeat;
    state.anticipateAge = 0;
  }
  state.low = follow(old.low, clamp(signals.low), dt, 1.8);
  state.gather = follow(old.gather, clamp(signals.tension * (0.4 + 1.6 * clamp(tensionGain))), dt, 0.65);
  state.dropAge = dropStarted ? 0 : old.dropAge < 0 ? -1 : old.dropAge + beats;
  if (Math.abs(state.dropAge - 4) < 1e-9) state.dropAge = 4;
  if (Math.abs(state.dropAge - 9) < 1e-9) state.dropAge = 9;
  const burstStarted = old.dropAge >= 0 && old.dropAge < 4 && state.dropAge >= 4 && !dropStarted;
  state.bloomAge = dropStarted ? -1 : burstStarted ? 0 : old.bloomAge < 0 ? -1 : old.bloomAge + dt;
  if (state.bloomAge >= 4) state.bloomAge = -1;
  if (state.dropAge >= 9) state.dropAge = -1;
  const age = state.dropAge;
  const replay = age >= 0 && age < 4 ? clamp(age / 3) : -1;
  const collapse = replay < 0 ? 0 : clamp(age - 3);
  const burstAge = age - 4;
  const burst = age >= 4 && age < 6 ? Math.sin(Math.PI * clamp(burstAge / 2)) * Math.exp(-burstAge * 0.6) : 0;
  const flood = age >= 4 ? 1 - clamp((age - 7) / 2) : 0;
  // Refill grows behind the jet in seconds, even at slow tempos.
  const bloom = state.bloomAge < 0 ? 0 : clamp((state.bloomAge - 0.15) / 0.65)
    * (1 - clamp((state.bloomAge - 2) / 2));
  const stroke = age >= 0 ? 0 : elasticStroke(state.kickAge) + 0.32 * elasticStroke(state.anticipateAge);
  return { state, stroke, gather: age >= 0 ? 0 : state.gather, low: state.low,
    replay, collapse, burst, flood, bloom, dropStarted, burstStarted };
}

export const HISTORY_FRAMES = 17;
export const HISTORY_INTERVAL = 0.25;

export interface HistoryState { newest: number; count: number; nextBeat: number }
export const initialHistory = (): HistoryState => ({ newest: -1, count: 0, nextBeat: 0 });

export function captureHistory(old: HistoryState, beat: number): { state: HistoryState; slot: number | null } {
  if (beat < old.nextBeat) return { state: old, slot: null };
  const slot = (old.newest + 1) % HISTORY_FRAMES;
  return { slot, state: { newest: slot, count: Math.min(HISTORY_FRAMES, old.count + 1),
    nextBeat: (Math.floor(beat / HISTORY_INTERVAL + 1e-9) + 1) * HISTORY_INTERVAL } };
}

/** Newest to oldest, with interpolation across the circular buffer seam. */
export function historyPair(state: HistoryState, progress: number): { a: number; b: number; mix: number } {
  const offset = clamp(progress) * Math.max(0, state.count - 1);
  const whole = Math.floor(offset);
  const index = (age: number) => (Math.max(0, state.newest) - age + HISTORY_FRAMES) % HISTORY_FRAMES;
  return { a: index(whole), b: index(Math.min(whole + 1, Math.max(0, state.count - 1))), mix: offset - whole };
}
