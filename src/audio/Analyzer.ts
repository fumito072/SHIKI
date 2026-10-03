export interface AudioFeatures {
  low: number;
  mid: number;
  high: number;
  level: number;
  /** 0..1 envelope on any transient. */
  onset: number;
  /** 0..1 envelope on low-band transients. */
  kick: number;
  /** Raw onset strength for the beat tracker (>= 0). */
  flux: number;
}

const BANDS = { low: [30, 150], mid: [150, 2000], high: [2000, 12000] } as const;

/** Follows a slowly decaying peak so that values land in 0..1 whatever the room level. */
class AutoLevel {
  private peak = 1e-4;
  constructor(private readonly release = 6, private readonly floor = 1e-4) {}
  norm(x: number, dt: number): number {
    this.peak = Math.max(x, this.peak * Math.exp(-dt / this.release), this.floor);
    return Math.min(1, x / this.peak);
  }
}

/** Attack/release smoothing in seconds. */
function follow(prev: number, x: number, dt: number, attack: number, release: number): number {
  const t = x > prev ? attack : release;
  return prev + (x - prev) * (1 - Math.exp(-dt / Math.max(t, 1e-4)));
}

/** Detects transients in a flux signal against an adaptive threshold. */
class OnsetDetector {
  private readonly hist = new Float32Array(48);
  private i = 0;
  private filled = 0;
  private since = 1;
  env = 0;

  constructor(
    private readonly k = 1.6,
    private readonly minGap = 0.11,
    private readonly release = 0.16,
    /** Absolute floor on the (auto-levelled) flux, so quiet passages don't produce onsets from noise. */
    private readonly minLevel = 0.15,
  ) {}

  step(flux: number, dt: number): number {
    let mean = 0;
    const n = Math.max(1, this.filled);
    for (let j = 0; j < this.filled; j++) mean += this.hist[j];
    mean /= n;
    let v = 0;
    for (let j = 0; j < this.filled; j++) v += (this.hist[j] - mean) ** 2;
    const std = Math.sqrt(v / n);

    this.hist[this.i] = flux;
    this.i = (this.i + 1) % this.hist.length;
    this.filled = Math.min(this.filled + 1, this.hist.length);
    this.since += dt;

    if (this.filled > 8 && flux > this.minLevel && flux > mean + this.k * std + 1e-3 && this.since > this.minGap) {
      this.since = 0;
      this.env = 1;
    } else {
      this.env *= Math.exp(-dt / this.release);
    }
    return this.env;
  }
}

/** Turns FFT frames into smoothed, auto-levelled features. */
export class Analyzer {
  private readonly mag: Float32Array;
  private readonly prev: Float32Array;
  private readonly ranges: Record<keyof typeof BANDS, [number, number]>;
  private readonly fluxEnd: number;
  private readonly lowEnd: number;
  private readonly levels = { low: new AutoLevel(), mid: new AutoLevel(), high: new AutoLevel(), level: new AutoLevel() };
  private readonly onsets = new OnsetDetector();
  // Kicks must reach a third of the recent kick peak: pads and risers in a breakdown are not kicks.
  private readonly kicks = new OnsetDetector(1.4, 0.18, 0.14, 0.35);
  private readonly fluxLevel = new AutoLevel(4);
  private readonly lowFluxLevel = new AutoLevel(30);
  private readonly lowLinLevel = new AutoLevel(30);
  private readonly out: AudioFeatures = { low: 0, mid: 0, high: 0, level: 0, onset: 0, kick: 0, flux: 0 };

  constructor(binCount: number, sampleRate: number) {
    this.mag = new Float32Array(binCount);
    this.prev = new Float32Array(binCount);
    const hz = sampleRate / 2 / binCount;
    const bin = (f: number) => Math.min(binCount - 1, Math.max(1, Math.round(f / hz)));
    this.ranges = {
      low: [bin(BANDS.low[0]), bin(BANDS.low[1])],
      mid: [bin(BANDS.mid[0]), bin(BANDS.mid[1])],
      high: [bin(BANDS.high[0]), bin(BANDS.high[1])],
    };
    this.fluxEnd = bin(8000);
    this.lowEnd = bin(160);
  }

  /** `db` is AnalyserNode.getFloatFrequencyData output. */
  process(db: Float32Array, dt: number): AudioFeatures {
    const { mag, prev } = this;
    for (let i = 0; i < mag.length; i++) {
      const d = db[i];
      mag[i] = d > -160 ? Math.log1p(100 * Math.pow(10, d / 20)) : 0;
    }

    const band = (r: [number, number]) => {
      let s = 0;
      for (let i = r[0]; i <= r[1]; i++) s += mag[i];
      return s / (r[1] - r[0] + 1);
    };
    const low = band(this.ranges.low);
    const mid = band(this.ranges.mid);
    const high = band(this.ranges.high);
    const level = (low + mid + high) / 3;

    // Linear low-band loudness (not log-compressed), to tell a kick from a pad's beating.
    let lowLin = 0;
    for (let i = 1; i < this.lowEnd; i++) lowLin += db[i] > -160 ? Math.pow(10, db[i] / 20) : 0;

    let flux = 0;
    let lowFlux = 0;
    for (let i = 1; i < this.fluxEnd; i++) {
      const d = mag[i] - prev[i];
      if (d > 0) {
        flux += d;
        if (i < this.lowEnd) lowFlux += d;
      }
    }
    prev.set(mag);

    const o = this.out;
    o.low = follow(o.low, this.levels.low.norm(low, dt), dt, 0.015, 0.18);
    o.mid = follow(o.mid, this.levels.mid.norm(mid, dt), dt, 0.015, 0.12);
    o.high = follow(o.high, this.levels.high.norm(high, dt), dt, 0.01, 0.08);
    o.level = follow(o.level, this.levels.level.norm(level, dt), dt, 0.02, 0.25);
    o.onset = this.onsets.step(this.fluxLevel.norm(flux, dt), dt);
    // A kick is a transient whose change is dominated by the low band (hats and snares spread across the spectrum)
    // and whose low-band loudness reaches half of recent kicks (a pad's beating or a bass swell does not).
    const lowNorm = this.lowFluxLevel.norm(lowFlux, dt);
    const lowLoud = this.lowLinLevel.norm(lowLin, dt);
    const kickiness = flux > 1e-6 ? lowFlux / flux : 0;
    o.kick = this.kicks.step(kickiness > 0.12 && lowLoud > 0.5 ? lowNorm : 0, dt);
    o.flux = flux;
    return o;
  }
}
