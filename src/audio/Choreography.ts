/**
 * Musical structure signals for choreography (docs/philosophy.md):
 * - tension rises while the kick is gone (breakdowns, builds), faster as the highs climb;
 * - drop fires when the kick comes back after a build, or when the performer hits DROP.
 */
export class Choreography {
  tension = 0;
  drop = 0;
  /** While true (performer holds BUILD), tension climbs regardless of the music. */
  building = false;

  private kickAvg = 0;
  private quietFor = 0;
  private lastKick = 0;
  private fired = false;

  /** Performer's DROP. */
  fire(): void {
    this.fired = true;
  }

  step(f: { kick: number; level: number; high: number }, dt: number): { tension: number; drop: number } {
    const hit = f.kick > 0.95 && this.lastKick <= 0.95;
    this.lastKick = f.kick;
    const wasQuiet = this.quietFor >= 2;

    const k = f.kick > this.kickAvg ? 0.25 : 2.0;
    this.kickAvg += (f.kick - this.kickAvg) * (1 - Math.exp(-dt / k));
    const quiet = this.kickAvg < 0.12;
    this.quietFor = quiet && !hit && f.level > 0.08 ? this.quietFor + dt : quiet && !hit ? this.quietFor : 0;

    // Silence is not a breakdown: tension only builds while music is actually playing.
    const playing = f.level > 0.08;
    if (this.building) this.tension = Math.min(1, this.tension + dt * 0.25);
    else if (quiet && playing) this.tension = Math.min(1, this.tension + dt * (0.03 + 0.1 * f.high + 0.05 * f.level));
    else if (!quiet) this.tension = Math.max(0, this.tension - dt * 0.1);

    if (this.fired || (hit && wasQuiet && this.tension > 0.2)) {
      this.drop = 1;
      this.tension = 0;
      this.fired = false;
    } else {
      this.drop *= Math.exp(-dt / 2.2);
    }
    return { tension: this.tension, drop: this.drop };
  }
}
