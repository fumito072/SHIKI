// The editor of a world: decides, from the music, when to cut, which shot to cut to and which look to use.
// Dynamism in the reference works comes from editing as much as from motion: cuts on bars that speed up with energy,
// one long held push-in through a build, a hard cut + flash + inverted look on the drop, slow shots in breakdowns.
// Pure logic (no rendering) so it is testable and the same in every window.
import type { Signals } from '../../types';

export type Phase = 'calm' | 'groove' | 'build' | 'impact';

export interface DirectorOptions {
  shots: number;
  styles: number;
  /** Shot to cut to on the drop. */
  impactShot: number;
  /** Shot held through a build. */
  buildShot: number;
  /** Shots for quiet passages. */
  calmShots: number[];
  /** Looks allowed on the drop cut (default: any other than the current one). */
  impactStyles?: number[];
  seed?: number;
}

export interface DirectorState {
  phase: Phase;
  shot: number;
  style: number;
  /** Beats since the current shot started. */
  local: number;
  /** 1 on a drop cut, decays over a beat or two. */
  flash: number;
  /** Seconds since the last kick onset (for waves that travel after a hit). */
  kickAge: number;
  /** Increments on every cut (lets a world re-seed per shot). */
  cut: number;
}

export class Director {
  private state: DirectorState = { phase: 'calm', shot: 0, style: 0, local: 0, flash: 0, kickAge: 99, cut: 0 };
  private shotStart = 0;
  private lastBar = -1;
  private lastDrop = 0;
  private lastKick = 0;
  private impactUntil = -1;
  private rnd: () => number;

  constructor(private readonly o: DirectorOptions) {
    let s = (o.seed ?? 7) >>> 0 || 7;
    this.rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
    this.state.shot = o.calmShots[0] ?? 0;
  }

  get current(): Readonly<DirectorState> {
    return this.state;
  }

  /** Forces a cut (performer's override). */
  cutTo(shot: number, beats: number, style?: number): void {
    this.cut(shot, beats, style);
  }

  update(s: Signals): DirectorState {
    const st = this.state;
    const beats = s.beats;
    const bar = Math.floor(beats / 4);
    const newBar = bar !== this.lastBar;
    this.lastBar = bar;

    // Kick onset age.
    if (s.kick > 0.9 && this.lastKick <= 0.9) st.kickAge = 0;
    else st.kickAge += s.dt;
    this.lastKick = s.kick;

    // Drop: rising edge of the drop envelope.
    const dropEdge = s.drop > 0.9 && this.lastDrop <= 0.9;
    this.lastDrop = s.drop;

    const energy = Math.min(1, s.level * 0.5 + s.low * 0.5);
    const building = s.tension > 0.25 && s.kick < 0.5;
    let phase: Phase = energy < 0.15 && !building ? 'calm' : building ? 'build' : 'groove';
    if (beats < this.impactUntil) phase = 'impact';

    if (dropEdge) {
      const allowed = (this.o.impactStyles ?? Array.from({ length: this.o.styles }, (_, i) => i)).filter((i) => i !== st.style);
      const style = allowed.length ? allowed[Math.floor(this.rnd() * allowed.length)] : st.style;
      this.cut(this.o.impactShot, beats, style);
      st.flash = 1;
      this.impactUntil = beats + 8; // two bars of impact before normal editing resumes
      phase = 'impact';
    } else if (phase === 'build') {
      // Hold one shot through the build; enter it on a bar.
      if (st.shot !== this.o.buildShot && newBar) this.cut(this.o.buildShot, beats);
    } else if (phase === 'impact') {
      // Frenzy after the drop: cut every 2 beats on the kick.
      if (beats - this.shotStart >= 2 && st.kickAge < 0.05) this.cut(this.pick(), beats);
    } else if (newBar) {
      const held = (beats - this.shotStart) / 4;
      const every = phase === 'calm' ? 8 : energy > 0.6 ? 1 : energy > 0.35 ? 2 : 4;
      if (held >= every - 0.01) {
        const shot = phase === 'calm' ? this.pickFrom(this.o.calmShots) : this.pick();
        const restyle = phase === 'groove' && this.rnd() < 0.2;
        this.cut(shot, beats, restyle ? Math.floor(this.rnd() * this.o.styles) : undefined);
      }
    }

    st.phase = phase;
    st.local = beats - this.shotStart;
    st.flash *= Math.exp(-s.dt / 0.35);
    return st;
  }

  private cut(shot: number, beats: number, style?: number) {
    this.state.shot = shot;
    if (style !== undefined) this.state.style = style;
    this.shotStart = beats;
    this.state.local = 0;
    this.state.cut++;
  }

  private pick(): number {
    const all = Array.from({ length: this.o.shots }, (_, i) => i).filter((i) => i !== this.o.buildShot);
    return this.pickFrom(all);
  }

  private pickFrom(list: number[]): number {
    const pool = list.filter((i) => i !== this.state.shot);
    if (!pool.length) return list[0] ?? 0;
    return pool[Math.floor(this.rnd() * pool.length)];
  }
}
