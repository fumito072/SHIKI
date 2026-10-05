import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { InputError, Store } from './store';
import type { Job, Project, StudioModel } from './types';
import type { Emit } from './jobs';

const BASE = 'https://api.meshy.ai/openapi/v1';
const MISSING = 'Meshy の API キーが .env にありません';
const CATEGORIES = ['Dancing', 'WalkAndRun', 'BodyMovements', 'DailyActions', 'Fighting'];
type ObjectValue = Record<string, unknown>;
type Stage = 'image-to-3d' | 'rigging' | 'animations';
function object(value: unknown): ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as ObjectValue : {};
}
function unwrap(value: unknown): ObjectValue {
  const top = object(value);
  if (typeof top.status === 'string') return top;
  for (const field of ['result', 'data']) {
    const nested = object(top[field]);
    if (typeof nested.status === 'string') return { ...top, ...nested };
  }
  return top;
}

export interface ModelRequest {
  item: string; rig: boolean; actions: number[]; polycount?: number; pose: '' | 'a-pose' | 't-pose'; pbr: boolean;
}
export function modelRequest(store: Store, project: Project, body: ObjectValue): ModelRequest {
  if (typeof body.item !== 'string' || !/^[a-z0-9-]{1,64}$/.test(body.item)) throw new InputError('Invalid item');
  const item = store.item(project, body.item);
  if (item.status !== 'done' || !item.file) throw new InputError('Image is not ready');
  const image = store.image(project.id, item.file);
  if (image.type !== 'image/png') throw new InputError('Meshy requires a PNG item image');
  if (body.rig !== undefined && typeof body.rig !== 'boolean') throw new InputError('Invalid rig');
  if (body.pbr !== undefined && typeof body.pbr !== 'boolean') throw new InputError('Invalid pbr');
  const actions = body.actions ?? [];
  if (!Array.isArray(actions) || actions.length > 10 || new Set(actions).size !== actions.length ||
    actions.some(a => typeof a !== 'number' || !Number.isSafeInteger(a) || a < 0)) throw new InputError('Actions must be 1–10 unique action ids (or omitted)');
  if (actions.length && body.rig !== true) throw new InputError('Animation requires rig: true (humanoid only)');
  const pose = body.pose ?? '';
  if (pose !== '' && pose !== 'a-pose' && pose !== 't-pose') throw new InputError('Invalid pose');
  const polycount = body.polycount;
  if (polycount !== undefined && (typeof polycount !== 'number' || !Number.isInteger(polycount) || polycount < 100 || polycount > 300000)) throw new InputError('Polycount must be 100–300000');
  return { item: item.id, rig: body.rig === true, actions, polycount: polycount as number | undefined, pose, pbr: body.pbr === true };
}

export class MeshyClient {
  private cache = new Map<string, { at: number; items: ObjectValue[] }>();
  constructor(private root: string, private transport: typeof fetch = fetch, private pollMs = 5000, private timeoutMs = 30 * 60 * 1000) {}

  private key(): string | undefined {
    const env = process.env.MESHY_API_KEY?.trim();
    if (env) return env;
    try {
      for (const line of readFileSync(join(this.root, '.env'), 'utf8').split(/\r?\n/)) {
        const match = /^\s*MESHY_API_KEY\s*=\s*(.*?)\s*$/.exec(line);
        if (match) {
          const value = match[1].replace(/^(['"])(.*)\1$/, '$2').trim();
          if (value) return value;
        }
      }
    } catch { /* Missing or unreadable configuration. */ }
    return undefined;
  }
  status() { return { configured: !!this.key() }; }
  requireKey() { if (!this.key()) throw new InputError(MISSING); }

  private safeString(value: unknown, key: string): value is string {
    return typeof value === 'string' && !value.includes(key) && !value.includes(encodeURIComponent(key));
  }
  private async api(path: string, key: string, signal?: AbortSignal, payload?: ObjectValue): Promise<unknown> {
    try {
      const response = await this.transport(`${BASE}/${path}`, {
        method: payload ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: payload ? JSON.stringify(payload) : undefined,
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000),
      });
      if (!response.ok) throw new Error(`Meshy API HTTP ${response.status}`);
      try { return await response.json(); } catch { throw new Error('Meshy API returned invalid JSON'); }
    } catch (error) {
      // Never forward transport errors or remote bodies: they can contain credentials and signed URLs.
      if (error instanceof Error && /^Meshy API (HTTP \d{3}|returned invalid JSON)$/.test(error.message)) throw error;
      throw new Error(signal?.aborted ? 'Meshy を中止しました。リモートのタスクは実行を続けます。' : 'Meshy API request failed');
    }
  }
  async library(category = '', search = '') {
    if (category && !CATEGORIES.includes(category)) throw new InputError('Invalid Meshy category');
    if (search.length > 200) throw new InputError('Meshy search exceeds 200 characters');
    const key = this.key(); if (!key) throw new InputError(MISSING);
    if (category.includes(key) || search.includes(key)) throw new InputError('Invalid Meshy library query');
    const query = new URLSearchParams({ category, search }).toString(), cached = this.cache.get(query);
    if (cached && Date.now() - cached.at < 3600000) return cached.items;
    const response = await this.api(`animations/library?${query}`, key);
    const top = object(response), nested = object(top.result ?? top.data);
    const values = Array.isArray(response) ? response : top.result ?? top.data ?? top.items;
    const list = Array.isArray(values) ? values : nested.result ?? nested.items ?? nested.animations;
    if (!Array.isArray(list)) throw new Error('Meshy library response is missing the action list');
    const items = list.map(value => {
      const item = object(value);
      if (typeof item.action_id !== 'number' || !Number.isSafeInteger(item.action_id) || item.action_id < 0 || !this.safeString(item.name, key)) throw new Error('Meshy library response has invalid action fields');
      const result: ObjectValue = { action_id: item.action_id, name: item.name };
      for (const field of ['key', 'category', 'sub_category', 'preview_url']) {
        if (item[field] !== undefined) {
          if (!this.safeString(item[field], key)) throw new Error('Meshy library response has invalid action fields');
          result[field] = field === 'preview_url' ? this.assetUrl(item[field], key) : item[field];
        }
      }
      return result;
    });
    if (this.cache.size >= 100) this.cache.clear();
    this.cache.set(query, { at: Date.now(), items });
    return items;
  }

  private async create(stage: Stage, payload: ObjectValue, key: string, signal: AbortSignal): Promise<string> {
    const response = object(await this.api(stage, key, signal, payload));
    const result = response.result ?? object(response.data).result ?? response.data;
    const id = typeof result === 'string' ? result : object(result).id ?? object(result).task_id ?? response.id ?? response.task_id;
    if (!this.safeString(id, key) || !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error(`Meshy ${stage}: response is missing a valid task id`);
    return id;
  }
  private async poll(stage: Stage, id: string, key: string, job: Job, emit: Emit) {
    const started = Date.now(), signal = job.abort.signal;
    while (Date.now() - started < this.timeoutMs) {
      signal.throwIfAborted();
      const task = unwrap(await this.api(`${stage}/${id}`, key, signal));
      const status = task.status;
      if (!['PENDING', 'IN_PROGRESS', 'SUCCEEDED', 'FAILED', 'CANCELED'].includes(String(status))) throw new Error(`Meshy ${stage}: response is missing a valid status`);
      const progress = typeof task.progress === 'number' && Number.isFinite(task.progress) ? Math.max(0, Math.min(100, task.progress)) : 0;
      emit(job, { type: 'status', text: `Meshy ${stage}: ${status} ${progress}%` });
      if (status === 'FAILED' || status === 'CANCELED') throw new Error(`Meshy ${stage}: ${status} (remote task failed; check Meshy dashboard)`);
      if (status === 'SUCCEEDED') return task;
      await delay(this.pollMs, undefined, { signal });
    }
    throw new Error(`Meshy ${stage}: polling timed out; remote task may still be running`);
  }
  private assetUrl(value: unknown, key: string): string {
    if (!this.safeString(value, key)) throw new Error('Meshy response is missing a valid asset URL');
    try {
      const url = new URL(value);
      if (url.protocol !== 'https:' || url.username || url.password) throw new Error();
      return value;
    } catch { throw new Error('Meshy response is missing a valid HTTPS asset URL'); }
  }
  private async download(store: Store, project: string, file: string, url: string, signal: AbortSignal, thumbnail = false) {
    let temp: string | undefined;
    try {
      const response = await this.transport(url, { signal: AbortSignal.any([signal, AbortSignal.timeout(120000)]) });
      if (!response.ok) throw new Error();
      const bytes = Buffer.from(await response.arrayBuffer());
      signal.throwIfAborted();
      if (!bytes.length || (file.endsWith('.glb') && bytes.subarray(0, 4).toString() !== 'glTF')) throw new Error();
      if (thumbnail) {
        const ext = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ? '.png'
          : bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255 ? '.jpg'
          : /^GIF8[79]a/.test(bytes.subarray(0, 6).toString()) ? '.gif'
          : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP' ? '.webp' : '';
        if (!ext) throw new Error();
        file = file.replace(/\.[^.]+$/, ext);
      }
      const target = store.file(project, file);
      temp = store.file(project, `${file}.${randomUUID()}.tmp`);
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(temp, bytes); renameSync(temp, target);
      return file;
    } catch { throw new Error('Meshy asset download failed or returned invalid data'); }
    finally { if (temp) rmSync(temp, { force: true }); }
  }

  async run(store: Store, project: Project, request: ModelRequest, job: Job, emit: Emit): Promise<string> {
    const key = this.key(); if (!key) throw new InputError(MISSING);
    const signal = job.abort.signal, stem = `models/${request.item}`;
    let record: StudioModel | undefined;
    const save = () => {
      if (!record) return;
      const current = store.get(project.id);
      current.models = [...(current.models ?? []).filter(m => m.item !== request.item), record];
      store.save(current);
    };
    const credits = (task: ObjectValue) => {
      const value = task.consumed_credits ?? object(task.result).consumed_credits;
      if (value === undefined) throw new Error('Meshy response is missing consumed_credits');
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('Meshy response has invalid consumed_credits');
      return value;
    };
    const assets = async (task: ObjectValue, primary: unknown, stage: Stage) => {
      const url = this.assetUrl(primary, key);
      // Freeze every returned asset, including basic animations, textures and alternate formats.
      const urls = new Set<string>([url]);
      let extra = 0;
      const walk = async (value: unknown, field = ''): Promise<void> => {
        if (typeof value === 'string' && /^https?:\/\//.test(value)) {
          if (urls.has(value)) return;
          urls.add(value);
          const asset = this.assetUrl(value, key);
          const ext = extname(new URL(asset).pathname).toLowerCase();
          const suffix = /^\.[a-z0-9]{1,8}$/.test(ext) ? ext : '.bin';
          const thumb = field === 'thumbnail_url';
          const path = thumb ? `${stem}-${stage}-thumb.png` : `${stem}-${stage}-asset-${++extra}${suffix}`;
          const saved = await this.download(store, project.id, path, asset, signal, thumb);
          if (thumb && record) { record.thumb = saved; save(); }
        } else if (Array.isArray(value)) {
          for (const entry of value) await walk(entry, field);
        } else {
          for (const [name, entry] of Object.entries(object(value))) await walk(entry, name);
        }
      };
      await walk(task.model_urls);
      await walk(task.texture_urls);
      await walk(task.basic_animations);
      await walk(task.animations);
      await walk(task.result);
      if (task.thumbnail_url) await walk(this.assetUrl(task.thumbnail_url, key), 'thumbnail_url');
    };
    try {
      signal.throwIfAborted();
      const item = store.item(project, request.item);
      if (!item.file) throw new InputError('Image is not ready');
      const bytes = readFileSync(store.image(project.id, item.file).file);
      if (!bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new InputError('Meshy requires a PNG item image');
      const image = await this.create('image-to-3d', {
        image_url: `data:image/png;base64,${bytes.toString('base64')}`, should_texture: true,
        enable_pbr: request.pbr, should_remesh: true, topology: 'triangle',
        ...(request.polycount === undefined ? {} : { target_polycount: request.polycount }),
        pose_mode: request.pose, target_formats: ['glb'],
      }, key, signal);
      const task = await this.poll('image-to-3d', image, key, job, emit);
      const result = object(task.result);
      const glb = object(task.model_urls ?? result.model_urls).glb;
      const imageCredits = credits(task);
      await this.download(store, project.id, `${stem}.glb`, this.assetUrl(glb, key), signal);
      record = { id: randomUUID(), item: request.item, file: `${stem}.glb`, tasks: { image }, credits: imageCredits, createdAt: Date.now() };
      save();
      await assets(task, glb, 'image-to-3d');
      if (request.rig) {
        record.tasks.rig = await this.create('rigging', { input_task_id: image, height_meters: 1.7 }, key, signal); save();
        const rig = await this.poll('rigging', record.tasks.rig, key, job, emit);
        record.credits += credits(rig); save();
        const rigged = object(rig.result).rigged_character_glb_url ?? rig.rigged_character_glb_url;
        const file = `${stem}-rigged.glb`;
        await this.download(store, project.id, file, this.assetUrl(rigged, key), signal);
        record.rigged = file; save();
        await assets(rig, rigged, 'rigging');
      }
      if (request.actions.length) {
        record.actions = request.actions;
        record.tasks.anim = await this.create('animations', { rig_task_id: record.tasks.rig, action_ids: request.actions }, key, signal); save();
        const animation = await this.poll('animations', record.tasks.anim, key, job, emit);
        record.credits += credits(animation); save();
        const result = object(animation.result);
        const list = Array.isArray(animation.result) ? animation.result : result.animations ?? animation.animations;
        const first = object(Array.isArray(list) ? list[0] : undefined);
        const animated = result.animation_glb_url ?? animation.animation_glb_url ?? first.animation_glb_url;
        const file = `${stem}-anim.glb`;
        await this.download(store, project.id, file, this.assetUrl(animated, key), signal);
        record.anim = file; save();
        await assets(animation, animated, 'animations');
      }
      signal.throwIfAborted();
      return `Meshy の3Dモデルを保存しました。consumed_credits: ${record.credits}`;
    } catch (error) {
      if (signal.aborted) throw new Error('Meshy を中止しました。リモートのタスクは実行を続けます。');
      // Filesystem errors may quote paths; remote errors are already replaced by fixed messages.
      if (error instanceof InputError || (error instanceof Error && error.message.startsWith('Meshy'))) throw error;
      throw new Error('Meshy model job failed');
    }
  }
}
