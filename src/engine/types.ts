import type { WebGLRenderer, WebGLRenderTarget } from 'three';

export const MAX_MACROS = 8;

export type SignalId = 'low' | 'mid' | 'high' | 'level' | 'onset' | 'kick' | 'beat' | 'bar';

export interface MacroDef {
  /** lower_snake id; becomes `M_<ID>` in GLSL. */
  id: string;
  label: string;
  /** Knob default, 0..1. */
  default: number;
  /** Modulation added on top of the knob: value = knob + signal * amount (clamped 0..1). */
  mod?: { source: SignalId; amount: number };
}

export interface InstrumentManifest {
  id: string;
  name: string;
  nameJa?: string;
  mood: string[];
  /** Energy band (0..1) the work fits, used for set planning. */
  energy: [number, number];
  tempo: 'sync' | 'free' | 'both';
  macros: MacroDef[];
  presets?: Record<string, Record<string, number>>;
}

/** Clock and audio signals shared by every window. */
export interface LiveSignals {
  bpm: number;
  /** 0..1 phase within the current beat. */
  beat: number;
  /** 0..1 phase within the current 4-beat bar. */
  bar: number;
  /** Continuous beat count. */
  beats: number;
  low: number;
  mid: number;
  high: number;
  level: number;
  /** 0..1 envelope on any transient. */
  onset: number;
  /** 0..1 envelope on low-band transients. */
  kick: number;
}

export interface Signals extends LiveSignals {
  /** Seconds since the engine started. */
  time: number;
  dt: number;
  frame: number;
}

export interface Frame {
  signals: Signals;
  /** Effective macro values (knob + modulation), manifest order, length MAX_MACROS. */
  macros: Float32Array;
  width: number;
  height: number;
}

export interface InstrumentContext {
  renderer: WebGLRenderer;
  manifest: InstrumentManifest;
  width: number;
  height: number;
}

export interface Instrument {
  render(frame: Frame, target: WebGLRenderTarget): void;
  resize?(width: number, height: number): void;
  dispose(): void;
}

export interface InstrumentModule {
  manifest: InstrumentManifest;
  create(ctx: InstrumentContext): Instrument;
}

export const SILENT: LiveSignals = {
  bpm: 120, beat: 0, bar: 0, beats: 0, low: 0, mid: 0, high: 0, level: 0, onset: 0, kick: 0,
};

export function defineInstrument(m: InstrumentModule): InstrumentModule {
  if (m.manifest.macros.length > MAX_MACROS) {
    throw new Error(`${m.manifest.id}: at most ${MAX_MACROS} macros`);
  }
  return m;
}
