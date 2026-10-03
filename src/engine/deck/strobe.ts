/** Beat subdivisions chosen below 8 Hz; a seconds-based guard also covers tempo/phase jumps. */
export class StrobeClock {
  private lastTime = -Infinity;
  private lastFlash = -Infinity;
  private cycle: number | null = null;
  private subdivision = 0;
  private duration = 0;

  reset(preserveRateLimit = false): void {
    if (!preserveRateLimit) this.lastTime = this.lastFlash = -Infinity;
    this.cycle = null;
    this.subdivision = this.duration = 0;
  }

  gate(time: number, beats: number, bpm: number, amount: number): number {
    if (![time, beats, bpm, amount].every(Number.isFinite) || bpm <= 0) return 1;
    if (time < this.lastTime) this.reset();
    this.lastTime = time;
    let subdivision = amount < 1 / 3 ? 1 : amount < 2 / 3 ? 2 : 4;
    while (bpm / 60 * subdivision > 8) subdivision /= 2;
    const position = beats * subdivision;
    const cycle = Math.floor(position);
    const boundary = cycle !== this.cycle || subdivision !== this.subdivision;
    this.cycle = cycle;
    this.subdivision = subdivision;
    if (boundary && position - cycle < 0.18 && time - this.lastFlash >= 0.125) {
      this.lastFlash = time;
      this.duration = Math.min(0.08, 0.18 / (bpm / 60 * subdivision));
    }
    return time - this.lastFlash < this.duration ? 1 : 0;
  }
}
