export type Deck = 'A' | 'B';
export type Transition = 'cut' | 'dissolve' | 'luma-wipe' | 'displace' | 'feedback-melt';
export type Quantize = 'now' | 'beat' | 'bar' | 'phrase16' | 'phrase32';

export interface TakeOptions {
  transition: Transition;
  beats: number;
  quantize: Quantize;
}

export interface ScheduledTake extends TakeOptions {
  startBeat: number;
  endBeat: number;
  from: Deck;
  to: Deck;
}

const periods: Record<Exclude<Quantize, 'now'>, number> = {
  beat: 1, bar: 4, phrase16: 16, phrase32: 32,
};

export const otherDeck = (deck: Deck): Deck => deck === 'A' ? 'B' : 'A';

/** Musical boundaries are strictly after the request, including exact boundaries. */
export function nextBoundary(beat: number, quantize: Quantize): number {
  if (!Number.isFinite(beat)) throw new Error('Beat must be finite');
  if (quantize === 'now') return beat;
  const period = periods[quantize];
  if (!period) throw new Error('Unknown quantization');
  return (Math.floor(beat / period) + 1) * period;
}

export function scheduleTake(beat: number, from: Deck, opts: TakeOptions, notBefore = beat): ScheduledTake {
  if (!Number.isFinite(opts.beats) || opts.beats < 0) throw new Error('Duration must be finite and nonnegative');
  if (!['cut', 'dissolve', 'luma-wipe', 'displace', 'feedback-melt'].includes(opts.transition)) {
    throw new Error('Unknown transition');
  }
  if (!Number.isFinite(notBefore)) throw new Error('Earliest start must be finite');
  let startBeat = nextBoundary(beat, opts.quantize);
  if (startBeat < notBefore) {
    startBeat = opts.quantize === 'now'
      ? notBefore
      : Math.ceil(notBefore / periods[opts.quantize]) * periods[opts.quantize];
  }
  // A cut has no in-between frames, regardless of the requested duration.
  const endBeat = startBeat + (opts.transition === 'cut' ? 0 : opts.beats);
  if (!Number.isFinite(endBeat)) throw new Error('Transition end must be finite');
  return { ...opts, startBeat, endBeat, from, to: otherDeck(from) };
}

/** One active take and one replaceable reservation; running takes are never interrupted. */
export class TakeScheduler {
  onAir: Deck = 'A';
  mix = 0;
  active: ScheduledTake | null = null;
  pending: ScheduledTake | null = null;
  progress = 0;

  request(beat: number, opts: TakeOptions): ScheduledTake {
    // Validate before advancing so malformed requests cannot change the state.
    scheduleTake(beat, this.onAir, opts);
    this.advance(beat);
    const take = scheduleTake(beat, this.active?.to ?? this.onAir, opts, this.active?.endBeat ?? beat);
    this.pending = take;
    if (!this.active) this.progress = 0;
    this.advance(beat);
    return take;
  }

  advance(beat: number): void {
    if (!Number.isFinite(beat)) throw new Error('Beat must be finite');
    // At most two completions, even when an offline frame jumps across both takes.
    for (let i = 0; i < 2; i++) {
      if (!this.active && this.pending && beat >= this.pending.startBeat) {
        this.active = this.pending;
        this.pending = null;
      }
      const take = this.active;
      if (!take) break;
      this.progress = take.endBeat === take.startBeat
        ? 1 : Math.min(1, Math.max(0, (beat - take.startBeat) / (take.endBeat - take.startBeat)));
      this.mix = take.from === 'A' ? this.progress : 1 - this.progress;
      if (this.progress < 1) break;
      this.onAir = take.to;
      this.mix = take.to === 'A' ? 0 : 1;
      this.active = null;
    }
  }

  cancel(): void {
    this.active = this.pending = null;
    this.progress = 0;
  }

  cutTo(deck: Deck): void {
    this.cancel();
    this.onAir = deck;
    this.mix = deck === 'A' ? 0 : 1;
  }
}
