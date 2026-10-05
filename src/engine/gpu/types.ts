// Instrument contract for the WebGPU engine (three/webgpu + TSL). Same manifest, frame and signals as the WebGL
// contract in ../types.ts; what changes is the renderer, and `create` may be async so a work can load its models
// and textures before its first frame.
import type { RenderTarget, WebGPURenderer } from 'three/webgpu';
import type { Frame, InstrumentManifest } from '../types';

export interface GpuInstrumentContext {
  renderer: WebGPURenderer;
  manifest: InstrumentManifest;
  width: number;
  height: number;
}

export interface GpuInstrument {
  /** Draw one frame into `target` (linear HDR, half float). Never render to the canvas directly. */
  render(frame: Frame, target: RenderTarget): void;
  resize?(width: number, height: number): void;
  dispose(): void;
  /** Optional state for HUDs and offline traces (current shot, phase …). */
  debug?(): Record<string, unknown>;
}

export interface GpuInstrumentModule {
  manifest: InstrumentManifest;
  /** May be async (GLB models, textures). Rejecting keeps the deck's previous work. */
  create(ctx: GpuInstrumentContext): GpuInstrument | Promise<GpuInstrument>;
  /** Marks the module for the WebGPU engine; WebGL-era works do not have it. */
  gpu: true;
}

export function defineGpuInstrument(m: Omit<GpuInstrumentModule, 'gpu'>): GpuInstrumentModule {
  return { ...m, gpu: true };
}
