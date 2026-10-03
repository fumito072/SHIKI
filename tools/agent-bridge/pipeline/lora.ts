import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { agentEnv } from './agents';
import type { Job } from './types';
import { killChild } from './jobs';

interface State { phase: string; message: string; results: { file: string; prompt?: string }[] }
function abortable<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Cancelled'));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    task.then(value => { signal.removeEventListener('abort', abort); resolve(value); }, error => {
      signal.removeEventListener('abort', abort); reject(error);
    });
  });
}

export class LoraClient {
  readonly dir: string;
  private queue: Promise<unknown> = Promise.resolve();
  private starting?: Promise<void>;
  constructor(private root: string, private base = 'http://127.0.0.1:7860', private pollMs = 1000, private timeoutMs = 300000, dir = process.env.SHIKI_LORA_DIR ?? join(homedir(), 'development/fumito_proj_2026/stableDiffusion_LoRA'), private transport: typeof fetch = fetch) { this.dir = dir; }
  private async request(path: string, init: RequestInit = {}, signal?: AbortSignal) {
    const response = await this.transport(this.base + path, { ...init, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
    return response;
  }
  async state(signal?: AbortSignal): Promise<State> {
    const response = await this.request('/api/state', {}, signal);
    if (!response.ok) throw new Error(`LoRA state HTTP ${response.status}`);
    const state = await response.json() as State;
    if (!state || typeof state.phase !== 'string' || !Array.isArray(state.results)) throw new Error('Invalid LoRA state');
    return state;
  }
  async status() {
    const installed = existsSync(join(this.dir, 'scripts/10_ui_server.py'));
    try {
      const state = await this.state();
      const config = await this.request('/api/config').then(r => r.ok ? r.json() : {}) as { loaded?: string | null };
      return { dir: this.dir, installed, running: true, phase: state.phase, loaded: config.loaded ?? null, message: state.message };
    } catch { return { dir: this.dir, installed, running: false, phase: 'stopped', loaded: null, message: 'LoRA server is stopped' }; }
  }
  async start(job?: Job): Promise<void> {
    if (this.starting) return abortable(this.starting, job?.abort.signal);
    this.starting = this.ensureReady(job).finally(() => { this.starting = undefined; });
    return this.starting;
  }
  private async ensureReady(job?: Job) {
    let running = false;
    try { await this.state(job?.abort.signal); running = true; } catch { job?.abort.signal.throwIfAborted(); }
    let launchError: Error | undefined;
    if (!running) {
      if (!existsSync(join(this.dir, 'scripts/10_ui_server.py'))) throw new Error(`LoRA server is not installed: ${this.dir}`);
      mkdirSync(join(this.root, '.agents'), { recursive: true });
      const log = openSync(join(this.root, '.agents/lora.log'), 'a');
      const proc = spawn('uv', ['run', '--group', 'eval', '--group', 'ui', 'scripts/10_ui_server.py'], { cwd: this.dir, env: agentEnv(), detached: true, stdio: ['ignore', log, log] });
      closeSync(log);
      job?.procs.add(proc);
      proc.on('error', error => { launchError = error; });
      proc.on('close', code => { job?.procs.delete(proc); launchError ??= new Error(`LoRA server exited (${code}); see .agents/lora.log`); });
      proc.unref();
      job?.abort.signal.addEventListener('abort', () => killChild(proc), { once: true });
    }
    const deadline = Date.now() + this.timeoutMs;
    while (Date.now() < deadline) {
      job?.abort.signal.throwIfAborted();
      if (launchError) throw launchError;
      let state: State | undefined;
      try { state = await this.state(job?.abort.signal); } catch { job?.abort.signal.throwIfAborted(); }
      if (state?.phase === 'error') throw new Error(`LoRA server: ${state.message}`);
      if (state && state.phase !== 'loading') return;
      await delay(this.pollMs, undefined, { signal: job?.abort.signal });
    }
    throw new Error('LoRA model load timed out after 5 minutes; see .agents/lora.log');
  }
  generate(prompt: string, target: string, weight = .75, signal?: AbortSignal): Promise<void> {
    const task = this.queue.catch(() => {}).then(() => this.generateOne(prompt, target, weight, signal));
    this.queue = task;
    return abortable(task, signal);
  }
  private async generateOne(prompt: string, target: string, weight: number, signal?: AbortSignal) {
    signal?.throwIfAborted();
    const deadline = Date.now() + Math.max(this.timeoutMs, 15 * 60000);
    let previous = new Set<string>();
    while (true) {
      signal?.throwIfAborted();
      if (Date.now() > deadline) throw new Error('LoRA generation timed out');
      const state = await this.state(signal);
      if (state.phase === 'loading' || state.phase === 'running') { await delay(this.pollMs, undefined, { signal }); continue; }
      previous = new Set(state.results.map(r => r.file));
      const response = await this.request('/api/generate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt, weight, width: 1344, height: 768, count: 1 }),
      }, signal);
      await response.arrayBuffer();
      if (response.status === 409) { await delay(this.pollMs, undefined, { signal }); continue; }
      if (!response.ok) throw new Error(`LoRA generation HTTP ${response.status}`);
      break;
    }
    while (Date.now() < deadline) {
      signal?.throwIfAborted();
      const state = await this.state(signal);
      if (state.phase === 'error') throw new Error(`LoRA generation: ${state.message}`);
      const result = state.results.find(r => !previous.has(r.file) && (!r.prompt || r.prompt === prompt || r.prompt === `fmtfila, ${prompt}`));
      if (state.phase === 'idle' && result) {
        if (!/^[a-zA-Z0-9_-]+\.png$/.test(result.file)) throw new Error('Unsafe LoRA gallery filename');
        const response = await this.request(`/gallery/${encodeURIComponent(result.file)}`, {}, signal);
        if (!response.ok) throw new Error(`LoRA image download HTTP ${response.status}`);
        const data = Buffer.from(await response.arrayBuffer());
        if (!data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('LoRA result is not PNG');
        signal?.throwIfAborted();
        writeFileSync(target, data); return;
      }
      await delay(this.pollMs, undefined, { signal });
    }
    throw new Error('LoRA generation timed out waiting for a new result');
  }
}
