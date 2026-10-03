/** Contract between the audio analyzer and the clock. Implemented by `BeatTracker`. */
export interface BeatEstimate {
  /** Estimated tempo, beats per minute. */
  bpm: number;
  /** 0..1 — how much the estimate can be trusted. Below ~0.4 the clock ignores it. */
  confidence: number;
  /** Time (ms, same clock as the pushed timestamps) of a recent beat; beats repeat every 60000 / bpm ms. */
  beatTimeMs: number;
}

export interface BeatTrackerLike {
  /** Feed one onset-strength sample (>= 0, unnormalized) observed at `timeMs`. Called ~60 times per second. */
  push(onsetStrength: number, timeMs: number): void;
  /** Current estimate, or null while there is not enough signal. */
  estimate(): BeatEstimate | null;
  reset(): void;
}
