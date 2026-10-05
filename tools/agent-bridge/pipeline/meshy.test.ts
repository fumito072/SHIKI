import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import type { Connect } from 'vite';
import { MeshyClient, modelRequest } from './meshy';
import { Store } from './store';
import { cancelJob, finishJob } from './jobs';
import { installPipeline } from './api';
import type { AgentEvent, Job, Project } from './types';

const KEY = 'test-private-meshy-key';
const SIGNED = 'https://assets.example/model.glb?signature=private-signed-token';
const THUMB = 'https://assets.example/thumb.png?signature=private-thumb-token';
const png = Buffer.from('89504e470d0a1a0a', 'hex');
const glb = Buffer.from('glTFfake-model');
let root: string, store: Store, project: Project, job: Job, events: Omit<AgentEvent, 'at'>[];
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const emit = (_job: Job, event: Omit<AgentEvent, 'at'>) => { events.push(event); };
function setupProject() {
  project = store.create('Creature', 'quiet creature');
  project.rounds = [{ n: 1, stage: 'look', feedback: '', director: { agent: 'codex', model: 'test', effort: '', notes: '' }, at: 1,
    items: [{ id: 'look-r1-01', file: 'look/r1-01.png', engine: 'gpt-image', prompt: 'creature', title: 'Creature', status: 'done', rating: 0, note: '' }] }];
  const file = store.file(project.id, 'look/r1-01.png'); mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, png);
  store.save(project);
  job = { id: 'job', agent: 'codex', model: 'meshy', effort: '', mode: 'create', kind: 'meshy', projectId: project.id, workId: project.id,
    message: '', keyVisual: false, attempt: 0, state: 'running', events: [], listeners: new Set(), procs: new Set(), abort: new AbortController(), started: 1 };
}
function request(options: Record<string, unknown> = {}) { return modelRequest(store, project, { item: 'look-r1-01', ...options }); }
function assertPrivate() {
  const visible = JSON.stringify(events) + readFileSync(store.file(project.id, 'project.json'), 'utf8');
  for (const secret of [KEY, SIGNED, THUMB, 'private-signed-token', 'private-thumb-token']) expect(visible).not.toContain(secret);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shiki-meshy-')); store = new Store(root); events = [];
  vi.stubEnv('MESHY_API_KEY', ''); writeFileSync(join(root, '.env'), `OTHER=x\nMESHY_API_KEY="${KEY}"\n`);
  setupProject();
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.useRealTimers(); rmSync(root, { recursive: true, force: true }); });

describe('Meshy with fake fetch only', () => {
  it('creates, polls with progress, downloads and records a model and thumbnail without secrets', async () => {
    let polls = 0;
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://api.meshy.ai/')) {
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${KEY}`);
        expect(url).not.toContain(KEY);
      } else expect(init?.headers).toBeUndefined();
      if (init?.method === 'POST') {
        expect(JSON.parse(String(init.body))).toEqual({ image_url: `data:image/png;base64,${png.toString('base64')}`, should_texture: true,
          enable_pbr: true, should_remesh: true, topology: 'triangle', target_polycount: 12000, pose_mode: 'a-pose', target_formats: ['glb'] });
        return json({ result: 'image-task' });
      }
      if (url.endsWith('/image-task')) return ++polls === 1 ? json({ status: 'IN_PROGRESS', progress: 42 })
        : json({ data: { status: 'SUCCEEDED', progress: 100, model_urls: { glb: SIGNED }, thumbnail_url: THUMB, consumed_credits: 20 } });
      if (url === SIGNED) return new Response(glb);
      if (url === THUMB) return new Response(png);
      throw new Error(`Unexpected transport ${KEY} ${SIGNED}`);
    });
    const client = new MeshyClient(root, transport, 1);
    expect(client.status()).toEqual({ configured: true });
    const summary = await client.run(store, project, request({ pbr: true, pose: 'a-pose', polycount: 12000 }), job, emit);
    finishJob(job, emit, undefined, summary);
    const model = store.get(project.id).models![0];
    expect(model).toMatchObject({ item: 'look-r1-01', file: 'models/look-r1-01.glb', tasks: { image: 'image-task' }, credits: 20 });
    expect(readFileSync(store.file(project.id, model.file))).toEqual(glb);
    expect(readFileSync(store.file(project.id, model.thumb!))).toEqual(png);
    expect(events.some(e => e.text.includes('42%'))).toBe(true);
    expect(events.at(-1)?.text).toContain('consumed_credits: 20');
    expect(transport.mock.calls.filter(([url]) => url === SIGNED)).toHaveLength(1);
    assertPrivate();
  });

  it('chains humanoid rigging and multiple actions, freezes every asset and sums credits', async () => {
    const payloads: { stage: string; body: unknown }[] = [], downloads: string[] = [];
    const rigged = 'https://assets.example/rigged.glb?token=secret';
    const walk = 'https://assets.example/walk.glb?token=secret';
    const anim = 'https://assets.example/anim.glb?token=secret';
    const secondAnim = 'https://assets.example/anim2.glb?token=secret';
    const texture = 'https://assets.example/texture.png?token=secret';
    const transport: typeof fetch = async (input, init) => {
      const url = String(input), stage = url.split('/').at(-1)!;
      if (init?.method === 'POST') {
        payloads.push({ stage, body: JSON.parse(String(init.body)) });
        return json({ result: { task_id: `${stage}-task` } });
      }
      if (url.endsWith('/image-to-3d-task')) return json({ status: 'SUCCEEDED', result: { model_urls: { glb: SIGNED }, texture_urls: [texture] }, consumed_credits: 20 });
      if (url.endsWith('/rigging-task')) return json({ result: { status: 'SUCCEEDED', progress: 100, consumed_credits: 5,
        result: { rigged_character_glb_url: rigged, basic_animations: { walking_glb_url: walk } } } });
      if (url.endsWith('/animations-task')) return json({ status: 'SUCCEEDED', consumed_credits: 6,
        result: { animations: [{ animation_glb_url: anim }, { animation_glb_url: secondAnim }] } });
      downloads.push(url);
      expect(init?.headers).toBeUndefined();
      return new Response(url === texture ? png : glb);
    };
    const summary = await new MeshyClient(root, transport, 1).run(store, project, request({ rig: true, actions: [10, 11] }), job, emit);
    expect(payloads[1]).toEqual({ stage: 'rigging', body: { input_task_id: 'image-to-3d-task', height_meters: 1.7 } });
    expect(payloads[2]).toEqual({ stage: 'animations', body: { rig_task_id: 'rigging-task', action_ids: [10, 11] } });
    const model = store.get(project.id).models![0];
    expect(model).toMatchObject({ rigged: 'models/look-r1-01-rigged.glb', anim: 'models/look-r1-01-anim.glb', actions: [10, 11],
      tasks: { image: 'image-to-3d-task', rig: 'rigging-task', anim: 'animations-task' }, credits: 31 });
    expect(summary).toContain('consumed_credits: 31');
    expect(downloads).toEqual([SIGNED, texture, rigged, walk, anim, secondAnim]);
    expect(readdirSync(store.file(project.id, 'models'))).toHaveLength(6);
    assertPrivate();
  });

  it.each(['FAILED', 'CANCELED'])('fails clearly on %s without forwarding remote task_error', async status => {
    const transport: typeof fetch = async (_url, init) => init?.method === 'POST' ? json({ result: 'task' })
      : json({ status, progress: 10, task_error: { message: `${KEY} ${SIGNED}` } });
    const error = await new MeshyClient(root, transport, 1).run(store, project, request(), job, emit).catch(e => e);
    expect(error.message).toContain(status);
    finishJob(job, emit, error);
    expect(store.get(project.id).models).toEqual([]);
    assertPrivate();
  });

  it('retains the base model if rigging fails, and preserves concurrent project edits', async () => {
    const transport: typeof fetch = async (input, init) => {
      const url = String(input);
      if (init?.method === 'POST') return json({ result: url.endsWith('rigging') ? 'rig-task' : 'image-task' });
      if (url.endsWith('rig-task')) return json({ status: 'FAILED', task_error: `${KEY} ${SIGNED}` });
      if (url.endsWith('image-task')) return json({ status: 'SUCCEEDED', consumed_credits: 12, model_urls: { glb: SIGNED } });
      store.update(project.id, 'Updated title', undefined);
      store.rate(project.id, 'look-r1-01', 1, 'keep');
      return new Response(glb);
    };
    await expect(new MeshyClient(root, transport, 1).run(store, project, request({ rig: true }), job, emit)).rejects.toThrow('FAILED');
    expect(store.get(project.id)).toMatchObject({ title: 'Updated title', rounds: [{ items: [{ rating: 1, note: 'keep' }] }],
      models: [{ file: 'models/look-r1-01.glb', credits: 12, tasks: { rig: 'rig-task' } }] });
    assertPrivate();
  });

  it('loads env first, reports a missing key and never calls fetch when missing', async () => {
    rmSync(join(root, '.env'));
    const transport = vi.fn<typeof fetch>();
    const client = new MeshyClient(root, transport);
    expect(client.status()).toEqual({ configured: false });
    expect(() => client.requireKey()).toThrow('Meshy の API キーが .env にありません');
    await expect(client.library()).rejects.toThrow('Meshy の API キーが .env にありません');
    await expect(client.run(store, project, request(), job, emit)).rejects.toThrow('Meshy の API キーが .env にありません');
    expect(transport).not.toHaveBeenCalled();
    vi.stubEnv('MESHY_API_KEY', KEY);
    expect(client.status()).toEqual({ configured: true });
    writeFileSync(join(root, '.env'), 'MESHY_API_KEY=wrong-key');
    const envTransport: typeof fetch = async (_input, init) => {
      expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${KEY}`);
      return json([]);
    };
    await new MeshyClient(root, envTransport).library();
  });

  it.each(['throw', 'http', 'json', 'task-id', 'status', 'asset-url', 'download'])('does not leak credentials or signed URLs on %s errors', async mode => {
    const transport: typeof fetch = async (input, init) => {
      if (mode === 'throw') throw new Error(`${KEY} ${SIGNED}`);
      if (mode === 'http') return new Response(`${KEY} ${SIGNED}`, { status: 401 });
      if (mode === 'json') return new Response(`${KEY} ${SIGNED}`);
      if (init?.method === 'POST') return json({ result: mode === 'task-id' ? KEY : 'task' });
      if (String(input).includes('api.meshy.ai')) return json({ status: mode === 'status' ? SIGNED : 'SUCCEEDED',
        consumed_credits: 0, model_urls: { glb: mode === 'asset-url' ? `https://assets.example/${KEY}` : SIGNED } });
      throw new Error(`${KEY} ${SIGNED}`);
    };
    const error = await new MeshyClient(root, transport, 1).run(store, project, request(), job, emit).catch(e => e);
    expect(error).toBeInstanceOf(Error); finishJob(job, emit, error);
    assertPrivate();
  });

  it('aborts the polling delay promptly and says that remote tasks continue', async () => {
    const transport = vi.fn<typeof fetch>(async (_input, init) => init?.method === 'POST' ? json({ result: 'task' }) : json({ status: 'PENDING', progress: 0 }));
    const task = new MeshyClient(root, transport, 5000).run(store, project, request(), job, emit);
    await vi.waitFor(() => expect(events).toHaveLength(1));
    cancelJob(job);
    await expect(task).rejects.toThrow('リモートのタスクは実行を続けます');
    expect(transport).toHaveBeenCalledTimes(2);
    expect(store.get(project.id).models).toEqual([]);
    assertPrivate();
  });

  it('handles nested task results while retaining credits from the outer response', async () => {
    const transport: typeof fetch = async (input, init) => init?.method === 'POST' ? json({ data: { result: 'task' } })
      : String(input).includes('api.meshy.ai') ? json({ consumed_credits: 9, result: { status: 'SUCCEEDED', model_urls: { glb: SIGNED } } })
      : new Response(glb);
    expect(await new MeshyClient(root, transport).run(store, project, request(), job, emit)).toContain('consumed_credits: 9');
    expect(store.get(project.id).models![0].credits).toBe(9);
    assertPrivate();
  });

  it('detects a thumbnail format from its bytes even when the URL has no extension', async () => {
    const thumbnail = 'https://assets.example/download?signature=private-thumb-token';
    const jpg = Buffer.from('ffd8ff', 'hex');
    const transport: typeof fetch = async (input, init) => init?.method === 'POST' ? json({ result: 'task' })
      : String(input).includes('api.meshy.ai') ? json({ status: 'SUCCEEDED', consumed_credits: 8, model_urls: { glb: SIGNED }, thumbnail_url: thumbnail })
      : new Response(String(input) === thumbnail ? jpg : glb);
    await new MeshyClient(root, transport).run(store, project, request(), job, emit);
    const model = store.get(project.id).models![0];
    expect(model.thumb).toBe('models/look-r1-01-image-to-3d-thumb.jpg');
    expect(store.image(project.id, model.thumb).type).toBe('image/jpeg');
    assertPrivate();
  });

  it.each(['model_urls', 'consumed_credits'])('fails clearly if a successful response omits %s', async field => {
    const transport: typeof fetch = async (_input, init) => {
      if (init?.method === 'POST') return json({ result: 'task' });
      const response: Record<string, unknown> = { status: 'SUCCEEDED', consumed_credits: 8, model_urls: { glb: SIGNED } };
      delete response[field];
      return json(response);
    };
    await expect(new MeshyClient(root, transport).run(store, project, request(), job, emit)).rejects.toThrow('missing');
    expect(store.get(project.id).models).toEqual([]);
    assertPrivate();
  });

  it('bounds polling and rejects invalid GLB downloads', async () => {
    const pending: typeof fetch = async (_input, init) => init?.method === 'POST' ? json({ result: 'task' }) : json({ status: 'PENDING' });
    await expect(new MeshyClient(root, pending, 1, 5).run(store, project, request(), job, emit)).rejects.toThrow('timed out');
    const invalid: typeof fetch = async (input, init) => init?.method === 'POST' ? json({ result: 'task' })
      : String(input).includes('api.meshy.ai') ? json({ status: 'SUCCEEDED', consumed_credits: 0, model_urls: { glb: SIGNED } }) : new Response('not glb');
    await expect(new MeshyClient(root, invalid).run(store, project, request(), job, emit)).rejects.toThrow('invalid data');
    expect(store.get(project.id).models).toEqual([]);
    assertPrivate();
  });

  it('caches the free library by category/search for one hour and whitelists fields', async () => {
    vi.useFakeTimers();
    const transport = vi.fn<typeof fetch>(async input => {
      expect(String(input)).toContain('category=Dancing&search=slow+turn');
      return json({ data: [{ action_id: 3, name: 'Turn', key: 'turn', category: 'Dancing', sub_category: 'slow', preview_url: 'https://example.com/preview.mp4', ignored: KEY }] });
    });
    const client = new MeshyClient(root, transport);
    expect(await client.library('Dancing', 'slow turn')).toEqual([{ action_id: 3, name: 'Turn', key: 'turn', category: 'Dancing', sub_category: 'slow', preview_url: 'https://example.com/preview.mp4' }]);
    await client.library('Dancing', 'slow turn'); expect(transport).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(3600000);
    await client.library('Dancing', 'slow turn'); expect(transport).toHaveBeenCalledTimes(2);
    await expect(client.library('unknown')).rejects.toThrow('Invalid Meshy category');
    await expect(client.library('', KEY)).rejects.toThrow('Invalid Meshy library query');
    await expect(new MeshyClient(root, async () => json({ result: [{ action_id: 1, name: KEY }] })).library()).rejects.toThrow('invalid action fields');
  });

  it('validates paid requests and refuses unready images and unsafe model paths', () => {
    for (const options of [{ polycount: 99 }, { polycount: 300001 }, { polycount: 100.5 }, { rig: 'yes' }, { pbr: 1 }, { pose: 'bad' },
      { actions: [1] }, { rig: true, actions: [1, 1] }, { rig: true, actions: [-1] }, { rig: true, actions: [1.5] }, { rig: true, actions: Array.from({ length: 11 }, (_, i) => i) }, { item: '../bad' }]) {
      expect(() => request(options)).toThrow();
    }
    project.rounds[0].items[0].status = 'running'; expect(() => request()).toThrow('not ready');
    expect(() => store.asset(project.id, '../x.glb')).toThrow('Unsafe');
    mkdirSync(store.file(project.id, 'models'));
    symlinkSync(store.file(project.id, 'project.json'), store.file(project.id, 'models/link.glb'));
    expect(() => store.asset(project.id, 'models/link.glb')).toThrow('Symlink');
    const old = { ...project }; delete old.models; store.save(old);
    expect(store.get(project.id).models).toEqual([]);
  });
});

function apiHarness() {
  let handler: Connect.NextHandleFunction;
  const middleware = { use(_path: string, value: Connect.NextHandleFunction) { handler = value; } } as unknown as Connect.Server;
  const jobs = new Map<string, Job>();
  installPipeline(middleware, root, jobs, (j, event) => { j.events.push({ ...event, at: Date.now() }); emit(j, event); }, async () => '', () => '');
  const call = (path: string, method = 'GET', value?: unknown, headers: Record<string, string> = {}) => {
    const req = new IncomingMessage(new Socket()); req.url = `/${path}`; req.method = method; req.headers = headers; req.complete = true;
    const res = new ServerResponse(req);
    const chunks: Buffer[] = [];
    const promise = new Promise<{ status: number; text: string; headers: ReturnType<ServerResponse['getHeaders']> }>(resolve => {
      res.write = ((data: string | Buffer) => { chunks.push(Buffer.from(data)); return true; }) as typeof res.write;
      res.end = ((data?: string | Buffer) => {
        if (data) chunks.push(Buffer.from(data));
        resolve({ status: res.statusCode, text: Buffer.concat(chunks).toString(), headers: res.getHeaders() }); return res;
      }) as typeof res.end;
    });
    req.push(value === undefined ? null : JSON.stringify(value)); if (value !== undefined) req.push(null);
    handler!(req, res, () => { res.statusCode = 404; res.end(); });
    return promise;
  };
  return { call, jobs };
}

describe('Studio Meshy endpoints', () => {
  it('exposes status/library/model jobs, serves GLB with ETag and rejects concurrent jobs', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>(resolve => { release = resolve; });
    const transport = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      if (url.includes('/library?')) return json([{ action_id: 1, name: 'Dance' }]);
      if (init?.method === 'POST') { await gate; return json({ result: 'task' }); }
      if (url.includes('api.meshy.ai')) return json({ status: 'SUCCEEDED', consumed_credits: 20, model_urls: { glb: SIGNED } });
      return new Response(glb);
    });
    vi.stubGlobal('fetch', transport);
    const h = apiHarness();
    expect(JSON.parse((await h.call('meshy/status')).text)).toEqual({ configured: true });
    expect(JSON.parse((await h.call('meshy/library?category=Dancing')).text)).toEqual([{ action_id: 1, name: 'Dance' }]);
    const response = await h.call('meshy/model', 'POST', { id: project.id, item: 'look-r1-01' });
    expect(response.status).toBe(200);
    const id = JSON.parse(response.text).job, j = h.jobs.get(id)!;
    expect(j).toMatchObject({ projectId: project.id, kind: 'meshy', state: 'running' });
    expect((await h.call('meshy/model', 'POST', { id: project.id, item: 'look-r1-01' })).status).toBe(409);
    expect((await h.call('project/choose', 'POST', { id: project.id, keyVisual: 'look-r1-01' })).status).toBe(409);
    expect((await h.call('project/rate', 'POST', { id: project.id, item: 'look-r1-01', rating: 1 })).status).toBe(200);
    release(); await vi.waitFor(() => expect(j.finished).toBeTypeOf('number'));
    expect(j.state).toBe('done'); expect(j.events.at(-1)?.text).toContain('consumed_credits: 20');
    const file = await h.call(`file?id=${project.id}&path=models/look-r1-01.glb`);
    expect(file.status).toBe(200); expect(file.text).toBe(glb.toString()); expect(file.headers['content-type']).toBe('model/gltf-binary');
    expect((await h.call(`file?id=${project.id}&path=models/look-r1-01.glb`, 'GET', undefined, { 'if-none-match': String(file.headers.etag) })).status).toBe(304);
    expect((await h.call('meshy/model')).status).toBe(405);
    assertPrivate();
  });

  it('reports missing keys before starting a paid job', async () => {
    rmSync(join(root, '.env'));
    const transport = vi.fn<typeof fetch>(); vi.stubGlobal('fetch', transport);
    const h = apiHarness();
    expect(JSON.parse((await h.call('meshy/status')).text)).toEqual({ configured: false });
    for (const response of [await h.call('meshy/library'), await h.call('meshy/model', 'POST', { id: project.id, item: 'look-r1-01' })]) {
      expect(response.status).toBe(400); expect(JSON.parse(response.text).error).toBe('Meshy の API キーが .env にありません');
    }
    expect(h.jobs.size).toBe(0); expect(transport).not.toHaveBeenCalled();
  });

  it('uses shared cancellation and includes the remote task warning in the done event', async () => {
    const transport: typeof fetch = async (_input, init) => init?.method === 'POST' ? json({ result: 'task' }) : json({ status: 'PENDING' });
    vi.stubGlobal('fetch', transport);
    const h = apiHarness();
    const response = await h.call('meshy/model', 'POST', { id: project.id, item: 'look-r1-01' });
    const j = h.jobs.get(JSON.parse(response.text).job)!;
    await vi.waitFor(() => expect(j.events).toHaveLength(1));
    cancelJob(j); await vi.waitFor(() => expect(j.finished).toBeTypeOf('number'));
    expect(j.events.at(-1)).toMatchObject({ type: 'done', text: 'Meshy を中止しました。リモートのタスクは実行を続けます。' });
    expect(j.listeners.size).toBe(0); assertPrivate();
  });
});
