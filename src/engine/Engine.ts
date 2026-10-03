import { Vector2, WebGLRenderer } from 'three';
import type { Texture, WebGLRenderTarget } from 'three';
import { FullscreenPass, createTarget } from './passes';
import type { Frame, Instrument, InstrumentModule, LiveSignals, Signals } from './types';
import { MAX_MACROS, SILENT } from './types';
import finishFrag from './finish.frag?raw';

export interface EngineOptions {
  canvas: HTMLCanvasElement;
  /** Render resolution relative to the canvas CSS size × devicePixelRatio. */
  scale?: number;
  maxPixelRatio?: number;
  onError?: (message: string, workId: string) => void;
  onLoad?: (workId: string) => void;
}

interface Current {
  module: InstrumentModule;
  instance: Instrument;
}

/**
 * Owns the renderer and the frame loop. Instruments draw linear HDR into `target`;
 * the finishing pass tone-maps it to the canvas. Loading is fail-safe: a work that
 * throws or fails to compile is rejected and the previous one keeps running.
 */
export class Engine {
  readonly renderer: WebGLRenderer;
  /** Knob values (0..1) in manifest order. */
  readonly knobs = new Float32Array(MAX_MACROS);
  /** Supplies clock + audio signals each frame. */
  signals: (now: number) => LiveSignals = () => SILENT;
  exposure = 1;
  fps = 0;

  private readonly opts: EngineOptions;
  private readonly effective = new Float32Array(MAX_MACROS);
  private readonly target: WebGLRenderTarget;
  private readonly scratch: WebGLRenderTarget;
  private readonly finishU = {
    uTex: { value: null as Texture | null },
    uResolution: { value: new Vector2(1, 1) },
    uTime: { value: 0 },
    uExposure: { value: 1 },
    uVignette: { value: 0.35 },
    uGrain: { value: 0.035 },
  };
  private readonly finish: FullscreenPass;
  private current: Current | null = null;
  private width = 1;
  private height = 1;
  private readonly t0 = performance.now();
  private last = performance.now();
  private frameNo = 0;
  private raf = 0;
  private shaderError: string | null = null;
  private failingFrames = 0;
  private readonly resizeObs: ResizeObserver;

  constructor(opts: EngineOptions) {
    this.opts = opts;
    this.renderer = new WebGLRenderer({
      canvas: opts.canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.autoClear = true;
    this.renderer.debug.checkShaderErrors = true;
    this.renderer.debug.onShaderError = (gl, program, vs, fs) => {
      const log = [gl.getProgramInfoLog(program), gl.getShaderInfoLog(vs), gl.getShaderInfoLog(fs)]
        .filter((s) => s && s.trim())
        .join('\n');
      this.shaderError = log || 'shader compile failed';
    };
    this.target = createTarget(1, 1);
    this.scratch = createTarget(64, 36);
    this.finish = new FullscreenPass({ fragmentShader: finishFrag, uniforms: this.finishU });
    this.resizeObs = new ResizeObserver(() => this.resize());
    this.resizeObs.observe(opts.canvas);
    this.resize();
  }

  get workId(): string | null {
    return this.current?.module.manifest.id ?? null;
  }

  get manifest() {
    return this.current?.module.manifest ?? null;
  }

  /** Effective macro values of the last frame (knob + modulation). */
  get macros(): Float32Array {
    return this.effective;
  }

  /**
   * Swap in a work. Returns false (and keeps the current work) if creating it,
   * compiling its shaders or rendering a trial frame fails.
   */
  load(module: InstrumentModule, opts: { keepKnobs?: boolean } = {}): boolean {
    const prev = this.current;
    const sameWork = prev?.module.manifest.id === module.manifest.id;
    const knobsBefore = this.knobs.slice();
    if (!sameWork && !opts.keepKnobs) this.resetKnobs(module);

    let instance: Instrument | null = null;
    this.shaderError = null;
    try {
      instance = module.create({
        renderer: this.renderer,
        manifest: module.manifest,
        width: this.width,
        height: this.height,
      });
      instance.render(this.makeFrame(performance.now(), 0, module), this.scratch);
      if (this.shaderError) throw new Error(this.shaderError);
    } catch (err) {
      try {
        instance?.dispose();
      } catch {
        /* ignore */
      }
      this.knobs.set(knobsBefore);
      this.opts.onError?.(errorText(err), module.manifest.id);
      return false;
    }

    this.current = { module, instance };
    this.failingFrames = 0;
    if (prev) prev.instance.dispose();
    this.opts.onLoad?.(module.manifest.id);
    return true;
  }

  resetKnobs(module: InstrumentModule | null = this.current?.module ?? null): void {
    this.knobs.fill(0);
    module?.manifest.macros.forEach((m, i) => (this.knobs[i] = m.default));
  }

  applyPreset(name: string): void {
    const manifest = this.current?.module.manifest;
    const preset = manifest?.presets?.[name];
    if (!manifest || !preset) return;
    manifest.macros.forEach((m, i) => {
      const v = preset[m.id];
      if (typeof v === 'number') this.knobs[i] = v;
    });
  }

  start(): void {
    const loop = (now: number) => {
      this.raf = requestAnimationFrame(loop);
      this.tick(now);
    };
    this.raf = requestAnimationFrame(loop);
  }

  stop(): void {
    cancelAnimationFrame(this.raf);
  }

  dispose(): void {
    this.stop();
    this.resizeObs.disconnect();
    this.current?.instance.dispose();
    this.current = null;
    this.target.dispose();
    this.scratch.dispose();
    this.finish.dispose();
    this.renderer.dispose();
  }

  /** Render one frame at `now` (ms) outside the rAF loop — used for deterministic offline capture. */
  renderAt(now: number): void {
    this.tick(now);
  }

  private tick(now: number): void {
    const dt = Math.min(0.1, Math.max(0, (now - this.last) / 1000));
    this.last = now;
    if (dt > 0) this.fps += (1 / dt - this.fps) * 0.05;

    const cur = this.current;
    if (cur) {
      try {
        cur.instance.render(this.makeFrame(now, dt, cur.module), this.target);
        this.failingFrames = 0;
      } catch (err) {
        // Keep showing the last good frame; report once per burst.
        if (this.failingFrames++ === 0) this.opts.onError?.(errorText(err), cur.module.manifest.id);
      }
    } else {
      this.renderer.setRenderTarget(this.target);
      this.renderer.clear();
    }

    this.finishU.uTex.value = this.target.texture;
    this.finishU.uResolution.value.set(this.width, this.height);
    this.finishU.uTime.value = (now - this.t0) / 1000;
    this.finishU.uExposure.value = this.exposure;
    this.finish.render(this.renderer, null);
    this.frameNo++;
  }

  private makeFrame(now: number, dt: number, module: InstrumentModule): Frame {
    const live = this.signals(now);
    const signals: Signals = { ...live, time: (now - this.t0) / 1000, dt, frame: this.frameNo };
    const defs = module.manifest.macros;
    for (let i = 0; i < MAX_MACROS; i++) {
      const def = defs[i];
      let v = this.knobs[i];
      if (def?.mod) v += signals[def.mod.source] * def.mod.amount;
      this.effective[i] = Math.min(1, Math.max(0, v));
    }
    return { signals, macros: this.effective, width: this.width, height: this.height };
  }

  private resize(): void {
    const canvas = this.opts.canvas;
    const ratio = Math.min(window.devicePixelRatio || 1, this.opts.maxPixelRatio ?? 2);
    const scale = this.opts.scale ?? 1;
    const w = Math.max(1, Math.round(canvas.clientWidth * ratio * scale));
    const h = Math.max(1, Math.round(canvas.clientHeight * ratio * scale));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.renderer.setSize(w, h, false);
    this.target.setSize(w, h);
    this.current?.instance.resize?.(w, h);
  }
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
