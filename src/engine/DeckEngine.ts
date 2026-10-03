import { Color, Vector2, WebGLRenderer } from 'three';
import type { Texture, WebGLRenderTarget } from 'three';
import { CopyPass, FullscreenPass, PingPong, createTarget } from './passes';
import type { Frame, Instrument, InstrumentModule, LiveSignals, Signals } from './types';
import { MAX_MACROS, SILENT } from './types';
import { TakeScheduler, otherDeck, scheduleTake } from './deck/scheduling';
import type { Deck, ScheduledTake, TakeOptions, Transition } from './deck/scheduling';
import { StrobeClock } from './deck/strobe';
import finishFrag from './finish.frag?raw';
import cutFrag from './transitions/cut.frag?raw';
import dissolveFrag from './transitions/dissolve.frag?raw';
import lumaFrag from './transitions/luma-wipe.frag?raw';
import displaceFrag from './transitions/displace.frag?raw';
import meltFrag from './transitions/feedback-melt.frag?raw';
import feedbackFrag from './fx/feedback.frag?raw';
import kaleidoFrag from './fx/kaleido.frag?raw';
import rgbFrag from './fx/rgb-split.frag?raw';
import grainFrag from './fx/grain.frag?raw';
import strobeFrag from './fx/strobe.frag?raw';

export type { Deck, Quantize, ScheduledTake, TakeOptions, Transition } from './deck/scheduling';
export type DeckSlot = Deck | 'safe';
export type MasterFx = 'feedback' | 'kaleido' | 'rgb-split' | 'grain' | 'strobe';
export interface FxState { on: boolean; amount: number }
/** CSS pixels relative to the canvas' top-left corner. */
export interface Rect { x: number; y: number; w: number; h: number }
/**
 * Multiview: where to draw the program and the deck previews inside one canvas. Without a layout the program
 * fills the canvas (output window).
 */
export interface DeckLayout { program: Rect; previews?: Partial<Record<Deck, Rect>> }
/** Everything an output window needs to mirror the control window's mix, FX and panic state. */
export interface DeckSyncState {
  onAir: Deck;
  mix: number;
  active: ScheduledTake | null;
  pending: ScheduledTake | null;
  fx: Record<MasterFx, FxState>;
  black: boolean;
  freeze: boolean;
  safe: boolean;
}
export interface DeckEngineOptions {
  canvas: HTMLCanvasElement;
  scale?: number;
  maxPixelRatio?: number;
  layout?: () => DeckLayout | null;
  onError?: (message: string, workId: string, deck: DeckSlot) => void;
  onLoad?: (workId: string, deck: DeckSlot) => void;
}

interface Current { module: InstrumentModule; instance: Instrument }
interface Slot {
  current: Current | null;
  target: WebGLRenderTarget;
  knobs: Float32Array;
  effective: Float32Array;
  preview: boolean;
  failures: number;
}

const transitionShaders: Record<Transition, string> = {
  cut: cutFrag, dissolve: dissolveFrag, 'luma-wipe': lumaFrag,
  displace: displaceFrag, 'feedback-melt': meltFrag,
};
const fxShaders: Record<MasterFx, string> = {
  feedback: feedbackFrag, kaleido: kaleidoFrag, 'rgb-split': rgbFrag, grain: grainFrag, strobe: strobeFrag,
};
const fxOrder: MasterFx[] = ['feedback', 'kaleido', 'rgb-split', 'grain', 'strobe'];
const bounded = (v: number): number => Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0;
const errorText = (err: unknown): string => err instanceof Error ? err.message : String(err);

/** Two HDR decks, beat-domain takes, optional master passes, and an independent panic slot. */
export class DeckEngine {
  readonly renderer: WebGLRenderer;
  readonly knobs: Record<Deck, Float32Array>;
  readonly macros: Record<Deck, Float32Array>;
  readonly fx: Record<MasterFx, FxState> = {
    feedback: { on: false, amount: 0.5 }, kaleido: { on: false, amount: 0.5 },
    'rgb-split': { on: false, amount: 0.5 }, grain: { on: false, amount: 0.5 },
    strobe: { on: false, amount: 0.5 },
  };
  signals: (now: number) => LiveSignals = () => SILENT;
  exposure = 1;
  fps = 0;

  private readonly decks: Record<Deck, Slot>;
  private safeSlot: Slot | null = null;
  private safeMode = false;
  private readonly scheduler = new TakeScheduler();
  private readonly strobe = new StrobeClock();
  private readonly trial = createTarget(64, 36);
  private workScratch = createTarget(1, 1);
  private mixed: WebGLRenderTarget | null = null;
  private frozen: WebGLRenderTarget | null = null;
  private lastMixed: Texture | null = null;
  private frozenValid = false;
  private freezing = false;
  private black = false;
  private melt: PingPong | null = null;
  private meltTake: ScheduledTake | null = null;
  private feedback: PingPong | null = null;
  private feedbackValid = false;
  private fxTargets: [WebGLRenderTarget, WebGLRenderTarget] | null = null;
  private readonly transitionPasses = new Map<Transition, FullscreenPass>();
  private readonly fxPasses = new Map<MasterFx, FullscreenPass>();
  private readonly copy = new CopyPass();
  private readonly transitionU = {
    uFrom: { value: null as Texture | null }, uTo: { value: null as Texture | null },
    uHistory: { value: null as Texture | null }, uProgress: { value: 0 },
    uResolution: { value: new Vector2(1, 1) }, uTime: { value: 0 }, uDt: { value: 0 }, uDecay: { value: 0 },
  };
  private readonly fxU = {
    uTex: { value: null as Texture | null }, uHistory: { value: null as Texture | null },
    uResolution: { value: new Vector2(1, 1) }, uTime: { value: 0 }, uBeat: { value: 0 },
    uAmount: { value: 0 }, uDecay: { value: 0 }, uGate: { value: 1 },
  };
  private readonly finishU = {
    uTex: { value: null as Texture | null }, uResolution: { value: new Vector2(1, 1) },
    uTime: { value: 0 }, uExposure: { value: 1 }, uVignette: { value: 0.35 }, uGrain: { value: 0.035 },
  };
  private readonly finish = new FullscreenPass({ fragmentShader: finishFrag, uniforms: this.finishU });
  private readonly clearColor = new Color();
  private readonly resizeObs: ResizeObserver;
  private width = 1;
  private height = 1;
  /** Canvas CSS size seen by the last resize; checked every frame because ResizeObserver stalls in hidden tabs. */
  private clientW = -1;
  private clientH = -1;
  private origin: number | null = null;
  private last: number | null = null;
  private live: Signals | null = null;
  private frameNo = 0;
  private raf = 0;
  private running = false;
  private disposed = false;
  private shaderError: string | null = null;

  constructor(private readonly opts: DeckEngineOptions) {
    this.renderer = new WebGLRenderer({ canvas: opts.canvas, antialias: false, alpha: false,
      powerPreference: 'high-performance' });
    this.renderer.autoClear = true;
    this.renderer.debug.checkShaderErrors = true;
    this.renderer.debug.onShaderError = (gl, program, vs, fs) => {
      this.shaderError = [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs)]
        .filter(s => s && s.trim()).join('\n') || 'shader compile failed';
    };
    this.decks = { A: this.newSlot(), B: this.newSlot() };
    this.knobs = { A: this.decks.A.knobs, B: this.decks.B.knobs };
    this.macros = { A: this.decks.A.effective, B: this.decks.B.effective };
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(opts.canvas);
    this.resize();
    this.clearBlack(this.decks.A.target);
    this.clearBlack(this.decks.B.target);
  }

  get onAir(): Deck { return this.scheduler.onAir; }
  set onAir(deck: Deck) {
    this.resumeDecks();
    this.scheduler.cutTo(deck);
  }
  get mix(): number { return this.scheduler.mix; }
  /** Manual crossfading cancels takes; onAir flips only at an endpoint. */
  set mix(value: number) {
    this.resumeDecks();
    this.scheduler.cancel();
    this.scheduler.mix = bounded(value);
    if (this.mix === 0) this.scheduler.onAir = 'A';
    if (this.mix === 1) this.scheduler.onAir = 'B';
  }
  get pending(): Readonly<ScheduledTake> | null {
    return this.scheduler.pending ? { ...this.scheduler.pending } : null;
  }
  get active(): Readonly<ScheduledTake> | null {
    return this.scheduler.active ? { ...this.scheduler.active } : null;
  }
  get progress(): number { return this.scheduler.progress; }
  get isBlackout(): boolean { return this.black; }
  get isFrozen(): boolean { return this.freezing; }
  get isSafe(): boolean { return this.safeMode; }
  workId(deck: DeckSlot): string | null { return this.slot(deck)?.current?.module.manifest.id ?? null; }
  manifest(deck: DeckSlot) { return this.slot(deck)?.current?.module.manifest ?? null; }

  load(deck: Deck, module: InstrumentModule, opts: { keepKnobs?: boolean } = {}): boolean {
    return this.install(deck, this.decks[deck], module, opts.keepKnobs ?? false);
  }

  resetKnobs(deck: Deck): void { this.defaults(this.decks[deck], this.decks[deck].current?.module); }
  applyPreset(deck: Deck, name: string): void {
    const slot = this.decks[deck];
    const manifest = slot.current?.module.manifest;
    const preset = manifest?.presets?.[name];
    if (!manifest || !preset) return;
    manifest.macros.forEach((m, i) => {
      if (typeof preset[m.id] === 'number') slot.knobs[i] = bounded(preset[m.id]);
    });
  }

  /** Pass a shared requestBeat when mirroring commands between control and output windows. */
  take(opts: TakeOptions, requestBeat?: number): boolean {
    if (this.disposed) return false;
    const beats = requestBeat ?? this.live?.beats ?? this.signals(performance.now()).beats;
    // Work out the destination after any take that already ended at this beat.
    const probe = new TakeScheduler();
    Object.assign(probe, this.scheduler);
    try {
      scheduleTake(beats, probe.onAir, opts);
      probe.advance(beats);
      const destination = otherDeck(probe.active?.to ?? probe.onAir);
      if (!this.decks[destination].current) return false;
      this.resumeDecks();
      this.scheduler.request(beats, opts);
      return true;
    } catch (err) {
      this.opts.onError?.(errorText(err), this.workId(this.onAir) ?? '', this.onAir);
      return false;
    }
  }

  /** Preview demand is explicit; textures can rotate, so query after each frame. */
  setPreview(deck: Deck, on: boolean): void { this.decks[deck].preview = on; }
  previewTexture(deck: Deck): Texture { return this.decks[deck].target.texture; }

  setFx(id: MasterFx, state: Partial<FxState>): void {
    if (state.on !== undefined) this.fx[id].on = state.on;
    if (state.amount !== undefined) this.fx[id].amount = bounded(state.amount);
    if (id === 'feedback' && (!this.fx[id].on || this.fx[id].amount === 0)) this.feedbackValid = false;
    if (id === 'strobe' && !this.fx[id].on) this.strobe.reset(true);
  }

  blackout(on: boolean): void { this.black = on; }
  /** Hold the pre-FX mix; previews and the musical scheduler can keep advancing. */
  freeze(on: boolean): void {
    if (on === this.freezing || this.disposed) return;
    this.freezing = on;
    this.frozenValid = false;
    if (on && this.lastMixed) this.captureFreeze(this.lastMixed);
  }

  setSafe(module: InstrumentModule): boolean {
    if (this.disposed) return false;
    const slot = this.safeSlot ?? this.newSlot();
    if (!this.install('safe', slot, module, false)) {
      if (!this.safeSlot) slot.target.dispose();
      return false;
    }
    this.safeSlot = slot;
    return true;
  }

  /** Panic bypasses master FX and clears freeze/blackout; assignment/take/mix returns to A/B. */
  safe(): boolean {
    if (!this.safeSlot?.current || this.disposed) return false;
    this.scheduler.cancel();
    this.freezing = this.frozenValid = this.black = false;
    this.safeMode = true;
    this.invalidateHistory();
    return true;
  }

  /** Snapshot for mirroring (sent to output windows every frame). */
  syncState(): DeckSyncState {
    const fx = {} as Record<MasterFx, FxState>;
    for (const id of fxOrder) fx[id] = { ...this.fx[id] };
    return {
      onAir: this.scheduler.onAir, mix: this.scheduler.mix,
      active: this.scheduler.active ? { ...this.scheduler.active } : null,
      pending: this.scheduler.pending ? { ...this.scheduler.pending } : null,
      fx, black: this.black, freeze: this.freezing, safe: this.safeMode,
    };
  }

  /** Mirror a control window. The scheduler then advances from the same beats, so takes stay in step. */
  applySync(s: DeckSyncState): void {
    const sch = this.scheduler;
    sch.onAir = s.onAir;
    sch.mix = bounded(s.mix);
    sch.active = s.active ? { ...s.active } : null;
    sch.pending = s.pending ? { ...s.pending } : null;
    for (const id of fxOrder) this.setFx(id, s.fx[id]);
    this.blackout(s.black);
    this.freeze(s.freeze);
    if (s.safe && !this.safeMode && this.safeSlot?.current) {
      this.safeMode = true;
      this.invalidateHistory();
    } else if (!s.safe && this.safeMode) this.resumeDecks();
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    const loop = (now: number) => {
      if (!this.running) return;
      this.raf = requestAnimationFrame(loop);
      this.tick(now);
    };
    this.raf = requestAnimationFrame(loop);
  }
  stop(): void {
    this.running = false;
    cancelAnimationFrame(this.raf);
    this.raf = 0;
  }
  /** Milliseconds on the same timeline as signals(now); first frame is time zero. */
  renderAt(now: number): void { if (!this.disposed) this.tick(now); }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stop();
    this.resizeObs.disconnect();
    for (const deck of ['A', 'B', 'safe'] as const) {
      const slot = this.slot(deck);
      if (!slot) continue;
      if (slot.current) this.release(slot.current, deck);
      slot.current = null;
      slot.target.dispose();
    }
    this.workScratch.dispose();
    this.trial.dispose();
    this.mixed?.dispose();
    this.frozen?.dispose();
    this.melt?.dispose();
    this.feedback?.dispose();
    this.fxTargets?.forEach(t => t.dispose());
    this.transitionPasses.forEach(pass => pass.dispose());
    this.fxPasses.forEach(pass => pass.dispose());
    this.finish.dispose();
    this.copy.dispose();
    this.renderer.dispose();
    this.lastMixed = null;
  }

  private newSlot(): Slot {
    const target = createTarget(this.width, this.height);
    this.clearBlack(target);
    return { current: null, target, knobs: new Float32Array(MAX_MACROS),
      effective: new Float32Array(MAX_MACROS), preview: false, failures: 0 };
  }
  private slot(deck: DeckSlot): Slot | null { return deck === 'safe' ? this.safeSlot : this.decks[deck]; }
  private defaults(slot: Slot, module?: InstrumentModule): void {
    slot.knobs.fill(0);
    module?.manifest.macros.forEach((m, i) => { if (i < MAX_MACROS) slot.knobs[i] = bounded(m.default); });
  }
  private install(deck: DeckSlot, slot: Slot, module: InstrumentModule, keepKnobs: boolean): boolean {
    if (this.disposed) return false;
    const prev = slot.current;
    const knobsBefore = slot.knobs.slice();
    const macrosBefore = slot.effective.slice();
    if (!keepKnobs && prev?.module.manifest.id !== module.manifest.id) this.defaults(slot, module);
    let instance: Instrument | null = null;
    const targetBefore = this.renderer.getRenderTarget();
    this.shaderError = null;
    try {
      if (module.manifest.macros.length > MAX_MACROS) throw new Error(`At most ${MAX_MACROS} macros`);
      instance = module.create({ renderer: this.renderer, manifest: module.manifest, width: this.width, height: this.height });
      const live = this.live ?? { ...this.signals(performance.now()), time: 0, dt: 0, frame: this.frameNo };
      instance.render(this.makeFrame(slot, module, { ...live, dt: 0 }), this.trial);
      if (this.shaderError) throw new Error(this.shaderError);
    } catch (err) {
      if (instance) this.release({ instance, module }, deck);
      slot.knobs.set(knobsBefore);
      slot.effective.set(macrosBefore);
      this.opts.onError?.(errorText(err), module.manifest.id, deck);
      return false;
    } finally {
      this.renderer.setRenderTarget(targetBefore);
    }
    slot.current = { module, instance };
    slot.failures = 0;
    if (prev) this.release(prev, deck);
    this.opts.onLoad?.(module.manifest.id, deck);
    return true;
  }
  private release(current: Current, deck: DeckSlot): void {
    try { current.instance.dispose(); }
    catch (err) { this.opts.onError?.(errorText(err), current.module.manifest.id, deck); }
  }
  private makeFrame(slot: Slot, module: InstrumentModule, signals: Signals): Frame {
    this.updateMacros(slot, module, signals);
    return { signals, macros: slot.effective, width: this.width, height: this.height };
  }
  private updateMacros(slot: Slot, module: InstrumentModule, signals: Signals): void {
    for (let i = 0; i < MAX_MACROS; i++) {
      const def = module.manifest.macros[i];
      slot.effective[i] = bounded(slot.knobs[i] + (def?.mod ? signals[def.mod.source] * def.mod.amount : 0));
    }
  }
  private renderSlot(deck: DeckSlot, slot: Slot, signals: Signals): void {
    const current = slot.current;
    if (!current) return;
    this.shaderError = null;
    try {
      current.instance.render(this.makeFrame(slot, current.module, signals), this.workScratch);
      if (this.shaderError) throw new Error(this.shaderError);
      // Commit only successful frames. A partially drawn failure cannot damage the last good texture.
      const old = slot.target;
      slot.target = this.workScratch;
      this.workScratch = old;
      slot.failures = 0;
    } catch (err) {
      if (slot.failures++ === 0) this.opts.onError?.(errorText(err), current.module.manifest.id, deck);
    }
  }
  private tick(now: number): void {
    if (!Number.isFinite(now)) throw new Error('Frame time must be finite');
    this.origin ??= now;
    const elapsed = this.last === null ? 0 : Math.max(0, (now - this.last) / 1000);
    if (elapsed > 0) this.fps += (1 / elapsed - this.fps) * 0.05;
    if (this.last !== null && now < this.last) this.invalidateHistory();
    this.last = now;
    const signals: Signals = { ...this.signals(now), time: (now - this.origin) / 1000,
      dt: Math.min(0.1, elapsed), frame: this.frameNo++ };
    this.live = signals;
    const canvas = this.opts.canvas;
    if (canvas.clientWidth !== this.clientW || canvas.clientHeight !== this.clientH) this.resize();
    const layout = this.opts.layout?.() ?? null;
    if (layout) this.fitProgram(layout);
    this.scheduler.advance(signals.beats);
    const hold = this.freezing && this.frozenValid;
    const active = this.scheduler.active;
    for (const deck of ['A', 'B'] as const) {
      const needed = !hold && !this.safeMode &&
        (active !== null || (deck === 'A' ? this.mix < 1 : this.mix > 0));
      if (needed || this.decks[deck].preview) this.renderSlot(deck, this.decks[deck], signals);
      else if (this.decks[deck].current) this.updateMacros(this.decks[deck], this.decks[deck].current!.module, signals);
    }
    let source: Texture;
    if (hold) {
      source = this.frozen!.texture;
      this.lastMixed = source;
    }
    else {
      if (this.safeMode && this.safeSlot) {
        this.renderSlot('safe', this.safeSlot, signals);
        source = this.safeSlot.target.texture;
      } else source = this.renderMix(signals);
      this.lastMixed = source;
      if (this.freezing) {
        this.captureFreeze(source);
        source = this.frozen!.texture;
      }
    }
    if (this.black) {
      this.feedbackValid = false;
      if (layout) return this.present(layout, null, signals);
      this.clearBlack(null);
      this.renderer.setRenderTarget(null);
      return;
    }
    if (!this.safeMode) source = this.renderFx(source, signals);
    if (layout) return this.present(layout, source, signals);
    this.finishU.uTex.value = source;
    this.finishU.uResolution.value.set(this.width, this.height);
    this.finishU.uTime.value = signals.time;
    this.finishU.uExposure.value = this.exposure;
    this.finish.render(this.renderer, null);
  }

  /** Multiview: program (black when null) and deck previews, each finished into its own viewport. */
  private present(layout: DeckLayout, program: Texture | null, signals: Signals): void {
    const r = this.renderer;
    const canvas = this.opts.canvas;
    const k = canvas.width / Math.max(1, canvas.clientWidth);
    r.setRenderTarget(null);
    r.setScissorTest(false);
    r.setViewport(0, 0, canvas.width, canvas.height);
    this.clearBlack(null);
    r.setScissorTest(true);
    const blit = (tex: Texture, rect: Rect) => {
      const x = Math.round(rect.x * k);
      const w = Math.round(rect.w * k);
      const h = Math.round(rect.h * k);
      const y = canvas.height - Math.round(rect.y * k) - h;
      if (w < 2 || h < 2) return;
      r.setViewport(x, y, w, h);
      r.setScissor(x, y, w, h);
      this.finishU.uTex.value = tex;
      this.finishU.uResolution.value.set(w, h);
      this.finish.render(r, null);
    };
    this.finishU.uTime.value = signals.time;
    this.finishU.uExposure.value = this.exposure;
    if (program) blit(program, layout.program);
    for (const deck of ['A', 'B'] as const) {
      const rect = layout.previews?.[deck];
      if (rect && this.decks[deck].current) blit(this.decks[deck].target.texture, rect);
    }
    r.setScissorTest(false);
    r.setViewport(0, 0, canvas.width, canvas.height);
  }
  private renderMix(signals: Signals): Texture {
    const take = this.scheduler.active;
    if (!take || take.transition !== 'feedback-melt') this.meltTake = null;
    if (!take && (this.mix === 0 || this.mix === 1)) {
      return this.decks[this.mix === 0 ? 'A' : 'B'].target.texture;
    }
    const kind = take?.transition ?? 'dissolve';
    const u = this.transitionU;
    u.uFrom.value = this.decks[take?.from ?? 'A'].target.texture;
    u.uTo.value = this.decks[take?.to ?? 'B'].target.texture;
    u.uProgress.value = take ? this.progress : this.mix;
    u.uResolution.value.set(this.width, this.height);
    u.uTime.value = signals.time;
    u.uDt.value = signals.dt;
    u.uDecay.value = Math.exp(-signals.dt * 5);
    let pass = this.transitionPasses.get(kind);
    if (!pass) {
      pass = new FullscreenPass({ fragmentShader: transitionShaders[kind], uniforms: u });
      this.transitionPasses.set(kind, pass);
    }
    if (kind === 'feedback-melt') {
      this.melt ??= new PingPong(this.width, this.height);
      if (this.meltTake !== take) {
        this.copy.render(this.renderer, u.uFrom.value, this.melt.read);
        this.meltTake = take;
      }
      u.uHistory.value = this.melt.read.texture;
      pass.render(this.renderer, this.melt.write);
      this.melt.swap();
      return this.melt.read.texture;
    }
    this.mixed ??= createTarget(this.width, this.height);
    pass.render(this.renderer, this.mixed);
    return this.mixed.texture;
  }
  private renderFx(input: Texture, signals: Signals): Texture {
    let source = input;
    const u = this.fxU;
    u.uResolution.value.set(this.width, this.height);
    u.uTime.value = signals.time;
    u.uBeat.value = signals.beat;
    for (const id of fxOrder) {
      const state = this.fx[id];
      const amount = bounded(state.amount);
      if (!state.on || amount === 0) {
        if (id === 'feedback') this.feedbackValid = false;
        if (id === 'strobe') this.strobe.reset(true);
        continue;
      }
      let pass = this.fxPasses.get(id);
      if (!pass) {
        pass = new FullscreenPass({ fragmentShader: fxShaders[id], uniforms: u });
        this.fxPasses.set(id, pass);
      }
      u.uTex.value = source;
      u.uAmount.value = amount;
      if (id === 'feedback') {
        this.feedback ??= new PingPong(this.width, this.height);
        if (!this.feedbackValid) {
          this.copy.render(this.renderer, source, this.feedback.read);
          this.feedbackValid = true;
        }
        u.uHistory.value = this.feedback.read.texture;
        u.uDecay.value = Math.exp(-signals.dt / (0.025 + amount * amount * 1.5));
        pass.render(this.renderer, this.feedback.write);
        this.feedback.swap();
        source = this.feedback.read.texture;
      } else {
        if (id === 'strobe') u.uGate.value = this.strobe.gate(signals.time, signals.beats, signals.bpm, amount);
        this.fxTargets ??= [createTarget(this.width, this.height), createTarget(this.width, this.height)];
        const target = this.fxTargets[source === this.fxTargets[0].texture ? 1 : 0];
        // Unused sampler uniforms must not accidentally refer to the destination.
        u.uHistory.value = null;
        pass.render(this.renderer, target);
        source = target.texture;
      }
    }
    return source;
  }
  private captureFreeze(source: Texture): void {
    this.frozen ??= createTarget(this.width, this.height);
    if (source !== this.frozen.texture) this.copy.render(this.renderer, source, this.frozen);
    this.frozenValid = true;
  }
  private resumeDecks(): void {
    if (this.safeMode) {
      this.safeMode = false;
      this.invalidateHistory();
    }
  }
  private invalidateHistory(): void {
    this.feedbackValid = false;
    this.meltTake = null;
    this.strobe.reset(true);
  }
  private clearBlack(target: WebGLRenderTarget | null): void {
    const previous = this.renderer.getRenderTarget();
    this.renderer.getClearColor(this.clearColor);
    const alpha = this.renderer.getClearAlpha();
    this.renderer.setClearColor(0, 1);
    this.renderer.setRenderTarget(target);
    this.renderer.clear();
    this.renderer.setClearColor(this.clearColor, alpha);
    this.renderer.setRenderTarget(previous);
  }
  private ratio(): number {
    return Math.min(window.devicePixelRatio || 1, this.opts.maxPixelRatio ?? 2);
  }
  /** With a layout the work targets follow the program rect, not the canvas. */
  private fitProgram(layout: DeckLayout): void {
    const k = this.ratio() * (this.opts.scale ?? 1);
    const w = Math.max(1, Math.round(layout.program.w * k));
    const h = Math.max(1, Math.round(layout.program.h * k));
    if (w !== this.width || h !== this.height) this.resizeTargets(w, h);
  }
  private resize(): void {
    if (this.disposed) return;
    this.clientW = this.opts.canvas.clientWidth;
    this.clientH = this.opts.canvas.clientHeight;
    const ratio = this.ratio();
    const cw = Math.max(1, Math.round(this.opts.canvas.clientWidth * ratio));
    const ch = Math.max(1, Math.round(this.opts.canvas.clientHeight * ratio));
    const layout = this.opts.layout?.() ?? null;
    if (layout) {
      this.renderer.setSize(cw, ch, false);
      this.fitProgram(layout);
      return;
    }
    const w = Math.max(1, Math.round(this.opts.canvas.clientWidth * ratio * (this.opts.scale ?? 1)));
    const h = Math.max(1, Math.round(this.opts.canvas.clientHeight * ratio * (this.opts.scale ?? 1)));
    this.renderer.setSize(w, h, false);
    this.resizeTargets(w, h);
  }
  private resizeTargets(w: number, h: number): void {
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.workScratch.setSize(w, h);
    for (const deck of ['A', 'B', 'safe'] as const) {
      const slot = this.slot(deck);
      if (!slot) continue;
      slot.target.setSize(w, h);
      this.clearBlack(slot.target);
      try { slot.current?.instance.resize?.(w, h); }
      catch (err) { this.opts.onError?.(errorText(err), slot.current!.module.manifest.id, deck); }
    }
    this.mixed?.setSize(w, h);
    this.frozen?.setSize(w, h);
    this.melt?.resize(w, h);
    this.feedback?.resize(w, h);
    this.fxTargets?.forEach(t => t.setSize(w, h));
    this.lastMixed = null;
    this.frozenValid = false;
    this.invalidateHistory();
  }
}
