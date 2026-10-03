import type { BeatEstimate, BeatTrackerLike } from './beat';

export interface BeatTrackerOptions {
  minBpm?: number;
  maxBpm?: number;
  historyMs?: number;
  gridMs?: number;
}

const clamp = (value: number, low: number, high: number): number =>
  Math.max(low, Math.min(high, value));

/** A recent-weighted onset autocorrelation, followed by a phase comb. */
export class BeatTracker implements BeatTrackerLike {
  private readonly minBpm: number;
  private readonly maxBpm: number;
  private readonly gridMs: number;
  private readonly history: Float64Array;
  private readonly envelope: Float64Array;
  private readonly weights: Float64Array;
  private readonly correlation: Float64Array;
  private count = 0;
  private head = 0;
  private latestTimeMs = NaN;
  private previousStrength = 0;
  private nextGridMs = 0;
  private lastAnalysisMs = -Infinity;
  private periodMs = 0;
  private anchorMs = 0;
  private confidence = 0;
  private pendingPeriodMs = 0;
  private pendingCount = 0;
  private consistentCount = 0;

  constructor(options: BeatTrackerOptions = {}) {
    this.minBpm = options.minBpm ?? 80;
    this.maxBpm = options.maxBpm ?? 170;
    this.gridMs = options.gridMs ?? 10;
    const historyMs = options.historyMs ?? 8000;
    if (![this.minBpm, this.maxBpm, this.gridMs, historyMs].every(Number.isFinite)
      || this.minBpm <= 0 || this.maxBpm <= this.minBpm
      || this.gridMs <= 0 || this.gridMs > 60000 / this.maxBpm / 8
      || historyMs < 3 * 60000 / this.minBpm) {
      throw new RangeError('Invalid beat tracker tempo, grid, or history range');
    }
    const size = Math.ceil(historyMs / this.gridMs);
    this.history = new Float64Array(size);
    this.envelope = new Float64Array(size);
    this.weights = new Float64Array(size);
    const maxLag = Math.ceil(60000 / this.minBpm / this.gridMs);
    this.correlation = new Float64Array(3 * maxLag + 3);
  }

  push(onsetStrength: number, timeMs: number): void {
    if (!Number.isFinite(timeMs) || !Number.isFinite(onsetStrength)
      || timeMs < this.latestTimeMs) return;
    const strength = Math.max(0, onsetStrength);
    if (!Number.isFinite(this.latestTimeMs)
      || timeMs - this.latestTimeMs >= this.history.length * this.gridMs) {
      this.reset();
      this.latestTimeMs = timeMs;
      this.previousStrength = strength;
      this.nextGridMs = timeMs;
    }
    const elapsed = timeMs - this.latestTimeMs;
    while (this.nextGridMs <= timeMs) {
      const mix = elapsed > 0 ? (this.nextGridMs - this.latestTimeMs) / elapsed : 1;
      // Missing audio frames are silence, not a stretched onset.
      this.history[this.head] = elapsed > 250 ? 0
        : this.previousStrength + mix * (strength - this.previousStrength);
      this.head = (this.head + 1) % this.history.length;
      this.count = Math.min(this.count + 1, this.history.length);
      this.nextGridMs += this.gridMs;
    }
    this.previousStrength = strength;
    this.latestTimeMs = timeMs;
  }

  estimate(): BeatEstimate | null {
    if (this.count * this.gridMs < Math.max(1800, 3 * 60000 / this.maxBpm)) return null;
    if (this.latestTimeMs - this.lastAnalysisMs >= 100) {
      this.lastAnalysisMs = this.latestTimeMs;
      this.analyze();
    }
    if (this.periodMs === 0) return null;
    const beatTimeMs = this.anchorMs
      + Math.floor((this.latestTimeMs - this.anchorMs) / this.periodMs) * this.periodMs;
    return { bpm: 60000 / this.periodMs, confidence: this.confidence, beatTimeMs };
  }

  reset(): void {
    this.count = 0;
    this.head = 0;
    this.latestTimeMs = NaN;
    this.previousStrength = 0;
    this.nextGridMs = 0;
    this.lastAnalysisMs = -Infinity;
    this.periodMs = 0;
    this.anchorMs = 0;
    this.confidence = 0;
    this.pendingPeriodMs = 0;
    this.pendingCount = 0;
    this.consistentCount = 0;
  }

  private analyze(): void {
    const n = this.count;
    let mean = 0;
    let weightSum = 0;
    let maximum = 0;
    for (let i = 0; i < n; i++) {
      const value = this.history[(this.head - n + i + this.history.length) % this.history.length];
      this.envelope[i] = value;
      const weight = Math.exp(-(n - 1 - i) * this.gridMs / 1500);
      this.weights[i] = weight;
      weightSum += weight;
      maximum = Math.max(maximum, value);
    }
    if (maximum === 0) {
      this.confidence *= 0.5;
      return;
    }
    // Scaling avoids overflow and makes confidence independent of input gain.
    for (let i = 0; i < n; i++) {
      this.envelope[i] /= maximum;
      mean += this.weights[i] * this.envelope[i];
    }
    mean /= weightSum;
    let energy = 0;
    for (let i = 0; i < n; i++) {
      this.envelope[i] -= mean;
      energy += this.weights[i] * this.envelope[i] ** 2;
    }
    if (energy / weightSum < 1e-8) {
      this.confidence *= 0.5;
      return;
    }
    const minPeriod = 60000 / this.maxBpm / this.gridMs;
    const maxPeriod = 60000 / this.minBpm / this.gridMs;
    const minLag = Math.max(1, Math.floor(minPeriod) - 1);
    // Require three periods of evidence, also for very wide custom ranges.
    const maxSearchPeriod = Math.min(maxPeriod, (n - 1) / 3);
    const correlationEnd = Math.min(this.correlation.length - 1, n - 40);
    for (let lag = minLag; lag <= correlationEnd; lag++) {
      let cross = 0;
      let left = 0;
      let right = 0;
      for (let i = lag; i < n; i++) {
        const a = this.envelope[i];
        const b = this.envelope[i - lag];
        const w = this.weights[i];
        cross += w * a * b;
        left += w * a * a;
        right += w * b * b;
      }
      this.correlation[lag] = left * right > 1e-12 ? cross / Math.sqrt(left * right) : 0;
    }
    let bestLag = minPeriod;
    let bestScore = -Infinity;
    let averageScore = 0;
    let scoreCount = 0;
    // Compare fractional periods so integer-bin octaves have no unfair advantage.
    for (let lag = minPeriod; lag <= maxSearchPeriod; lag += 0.25) {
      const score = this.tempoScore(lag, correlationEnd);
      averageScore += score;
      scoreCount++;
      if (score > bestScore) {
        bestScore = score;
        bestLag = lag;
      }
    }
    averageScore /= scoreCount;
    const prominence = clamp((bestScore - averageScore - 0.08) / 0.35, 0, 1);
    // Old beats in the ring must not keep confidence high through a dropout.
    const correlation = Math.min(this.sampleCorrelation(bestLag), this.recentCorrelation(Math.round(bestLag)));
    const periodicity = clamp((correlation - 0.25) / 0.5, 0, 1);
    const evidence = prominence * periodicity;
    if (evidence < 0.15) {
      this.confidence *= 0.5;
      this.consistentCount = 0;
      this.pendingCount = 0;
      return;
    }
    const beforeScore = this.tempoScore(bestLag - 0.25, correlationEnd);
    const afterScore = this.tempoScore(bestLag + 0.25, correlationEnd);
    const curvature = beforeScore - 2 * bestScore + afterScore;
    const refinement = curvature < -1e-9
      ? 0.25 * clamp(0.5 * (beforeScore - afterScore) / curvature, -0.5, 0.5) : 0;
    const candidateMs = clamp((bestLag + refinement) * this.gridMs,
      minPeriod * this.gridMs, maxPeriod * this.gridMs);
    if (this.periodMs > 0 && Math.abs(candidateMs / this.periodMs - 1) > 0.035) {
      if (Math.abs(candidateMs / this.pendingPeriodMs - 1) < 0.025) this.pendingCount++;
      else this.pendingCount = 1;
      this.pendingPeriodMs = candidateMs;
      if (this.pendingCount < 3) {
        this.confidence *= 0.8;
        return;
      }
      this.consistentCount = 0;
    } else {
      this.pendingCount = 0;
      this.consistentCount++;
    }
    const oldPeriod = this.periodMs;
    const oldAnchor = oldPeriod > 0 ? this.anchorMs
      + Math.floor((this.latestTimeMs - this.anchorMs) / oldPeriod) * oldPeriod : 0;
    this.periodMs = oldPeriod === 0 ? candidateMs : oldPeriod + 0.4 * (candidateMs - oldPeriod);
    const period = this.periodMs / this.gridMs;
    let bestOffset = 0;
    let phaseScore = -Infinity;
    // Search backwards from the newest grid sample; recent beats carry more weight.
    for (let offset = 0; offset < period; offset++) {
      const score = this.phaseScore(offset, period);
      if (score > phaseScore) {
        phaseScore = score;
        bestOffset = offset;
      }
    }
    const before = this.phaseScore(bestOffset - 1, period);
    const after = this.phaseScore(bestOffset + 1, period);
    const bend = before - 2 * phaseScore + after;
    const phaseRefinement = bend < -1e-9
      ? clamp(0.5 * (before - after) / bend, -0.5, 0.5) : 0;
    const candidateAnchor = this.nextGridMs - this.gridMs - (bestOffset + phaseRefinement) * this.gridMs;
    let phaseDelta = oldPeriod > 0 ? candidateAnchor - oldAnchor : 0;
    phaseDelta -= Math.round(phaseDelta / this.periodMs) * this.periodMs;
    this.anchorMs = oldPeriod === 0 ? candidateAnchor : oldAnchor + 0.5 * phaseDelta;
    const consistency = 0.7 + 0.3 * Math.min(1, this.consistentCount / 5);
    if (oldPeriod === 0) this.confidence = evidence * consistency;
    else this.confidence += 0.3 * (evidence * consistency - this.confidence);
  }

  private sampleCorrelation(lag: number): number {
    const i = Math.round(lag);
    const x = lag - i;
    const a = this.correlation[i - 1];
    const b = this.correlation[i];
    const c = this.correlation[i + 1];
    return clamp(b + 0.5 * x * (c - a + x * (a - 2 * b + c)), -1, 1);
  }

  private tempoScore(lag: number, end: number): number {
    let score = this.sampleCorrelation(lag);
    let total = 1;
    for (let multiple = 2; multiple <= 3; multiple++) {
      if (multiple * lag >= end - 1) break;
      const weight = multiple === 2 ? 0.35 : 0.15;
      score += weight * this.sampleCorrelation(multiple * lag);
      total += weight;
    }
    // A weak musical prior only breaks near ties between octaves.
    const bpm = 60000 / (lag * this.gridMs);
    const musicalPrior = 0.05 * Math.exp(-0.5 * (Math.log(bpm / 120) / 0.35) ** 2);
    const persistence = this.periodMs > 0
      ? 0.08 * Math.exp(-0.5 * (Math.log(lag * this.gridMs / this.periodMs) / 0.035) ** 2) : 0;
    return score / total + musicalPrior + persistence;
  }

  private recentCorrelation(lag: number): number {
    const start = Math.max(lag, this.count - Math.ceil(Math.max(1800 / this.gridMs, 3 * lag)) + lag);
    let aSum = 0;
    let bSum = 0;
    let cross = 0;
    let left = 0;
    let right = 0;
    const count = this.count - start;
    for (let i = start; i < this.count; i++) {
      const a = this.envelope[i];
      const b = this.envelope[i - lag];
      aSum += a;
      bSum += b;
      cross += a * b;
      left += a * a;
      right += b * b;
    }
    left -= aSum * aSum / count;
    right -= bSum * bSum / count;
    return left * right > 1e-12
      ? (cross - aSum * bSum / count) / Math.sqrt(left * right) : 0;
  }

  private phaseScore(offset: number, period: number): number {
    const n = this.count;
    offset = ((offset % period) + period) % period;
    let sum = 0;
    let weightSum = 0;
    for (let position = n - 1 - offset; position >= Math.max(0, n - 4000 / this.gridMs); position -= period) {
      const i = Math.floor(position);
      const fraction = position - i;
      const value = this.envelope[i] * (1 - fraction) + this.envelope[Math.min(i + 1, n - 1)] * fraction;
      const weight = Math.exp(-(n - 1 - position) * this.gridMs / 1500);
      sum += weight * Math.max(0, value);
      weightSum += weight;
    }
    return weightSum > 0 ? sum / weightSum : 0;
  }
}
