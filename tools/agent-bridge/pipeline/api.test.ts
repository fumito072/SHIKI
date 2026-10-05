import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Connect, ResolvedConfig, ViteDevServer } from 'vite';
import { agentBridge } from '../index';
import { generateGpt } from './images';
import { LoraClient } from './lora';
import { cancelJob } from './jobs';
import type { AgentEvent, Job, Project } from './types';

const fake = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async importOriginal => ({ ...await importOriginal<typeof import('node:child_process')>(), spawn: fake.spawn }));
const png = Buffer.from('89504e470d0a1a0a', 'hex');
interface Call { command: string; args: string[]; text: string; env: NodeJS.ProcessEnv; proc: EventEmitter & { kill: () => boolean }; complete: () => void }
let root: string, calls: Call[], holdImages: boolean, imageFallback: boolean, skipImage: boolean, starterSeen: string;

function harness() {
  const handlers: { prefix: string; handler: Connect.NextHandleFunction }[] = [];
  const middlewares = { use(prefix: string, handler: Connect.NextHandleFunction) { handlers.push({ prefix, handler }); } };
  const plugin = agentBridge();
  if (typeof plugin.configResolved === 'function') (plugin.configResolved as (config: ResolvedConfig) => void)({ root } as ResolvedConfig);
  if (typeof plugin.configureServer === 'function') (plugin.configureServer as (server: ViteDevServer) => void)({ middlewares } as unknown as ViteDevServer);
  const request = (path: string, method = 'GET', value?: unknown, headers: Record<string, string> = {}) => {
    const req = new IncomingMessage(new Socket()); req.url = path; req.method = method; req.headers = headers; req.complete = true;
    const res = new ServerResponse(req);
    let text = '';
    const result = new Promise<{ status: number; text: string; headers: ReturnType<ServerResponse['getHeaders']> }>(resolve => {
      res.write = ((chunk: string | Buffer) => { text += chunk.toString(); return true; }) as typeof res.write;
      res.end = ((chunk?: string | Buffer) => {
        if (chunk) text += chunk.toString();
        resolve({ status: res.statusCode, text, headers: res.getHeaders() }); return res;
      }) as typeof res.end;
    });
    const match = handlers.find(h => path === h.prefix || path.startsWith(h.prefix + '/') || path.startsWith(h.prefix + '?'));
    if (!match) throw new Error(`No handler: ${path}`);
    req.url = path.slice(match.prefix.length) || '/';
    match.handler(req, res, () => res.writeHead(404).end());
    if (value !== undefined) req.push(Buffer.from(JSON.stringify(value)));
    req.push(null);
    return result;
  };
  return { request, json: async (path: string, value: unknown) => JSON.parse((await request(path, 'POST', value)).text) };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'shiki-api-')); calls = []; holdImages = false; imageFallback = false; skipImage = false; starterSeen = "";
  mkdirSync(join(root, 'docs')); mkdirSync(join(root, 'works'));
  for (const doc of ['philosophy', 'taste', 'pinterest-aesthetic']) writeFileSync(join(root, 'docs', `${doc}.md`), doc);
  mkdirSync(join(root, 'works/_starter'));
  writeFileSync(join(root, 'works/_starter/index.ts'), "const manifest = { id: 'starter', // replaced\n}; defineGpuInstrument;");
  fake.spawn.mockImplementation((command: string, args: string[], options: { env: NodeJS.ProcessEnv }) => {
    const proc = new EventEmitter() as Call['proc'] & { stdin: PassThrough; stdout: PassThrough; stderr: PassThrough };
    proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
    const call: Call = { command, args, text: '', env: options.env, proc, complete: () => {} };
    calls.push(call);
    proc.kill = vi.fn(() => { queueMicrotask(() => proc.emit('close', null)); return true; });
    Object.assign(proc, { unref: () => proc });
    proc.stdin.on('data', b => { call.text += b.toString(); });
    call.complete = () => {
      if (command === 'sips') {
        const target = args[args.indexOf('--out') + 1]; writeFileSync(target, Buffer.from('ffd8ff', 'hex'));
      } else if (call.text.includes('Use your built-in image generation tool')) {
        const target = /exact absolute path: (.*)\. Edit only/.exec(call.text)![1];
        const path = imageFallback ? join(root, '.codex/generated_images/fresh.png') : target;
        if (!skipImage) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, png); }
      } else if (args.includes('read-only') || (args.includes('--tools') && args[args.indexOf('--tools') + 2] === '--allowedTools')) {
        const count = /Exactly (\d+) gpt-image/.exec(call.text)!;
        const motion = call.text.includes('chosen key visual: preserve');
        const json = JSON.stringify({ notes: '余白と予測誤差', items: Array.from({ length: Number(count[1]) }, (_, k) => ({ engine: 'gpt-image', title: motion ? `逆行${k}` : `Look ${k}`, prompt: `scene ${k}`, ...(motion ? { motion: 'tensionで凝集し、dropで時間が逆行する。' } : {}) })) });
        const text = `\`\`\`json\n${json}\n\`\`\``;
        proc.stdout.write(JSON.stringify(command === 'claude' ? { type: 'result', result: text } : { type: 'item.completed', item: { type: 'agent_message', text } }) + '\n');
      } else {
        const id = /Use exactly ([a-z0-9-]+) as folder/.exec(call.text)?.[1];
        if (id) {
          starterSeen = readFileSync(join(root, 'works', id, 'index.ts'), 'utf8');
          writeFileSync(join(root, 'works', id, 'index.ts'), 'export default {};');
        }
        const feedback = /Task: change the work in works\/([a-z0-9-]+)\//.exec(call.text)?.[1];
        if (feedback) writeFileSync(join(root, 'works', feedback, 'index.ts'), 'changed');
        proc.stdout.write(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: '完成' } }));
      }
      proc.emit('close', 0);
    };
    if (command === 'sips') queueMicrotask(call.complete);
    else proc.stdin.on('end', () => { if (!holdImages || !call.text.includes('Use your built-in image generation tool')) queueMicrotask(call.complete); });
    return proc;
  });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); vi.clearAllMocks(); vi.unstubAllEnvs(); });
async function done(h: ReturnType<typeof harness>, job: string) {
  await vi.waitFor(async () => {
    const jobs = JSON.parse((await h.request('/__shiki/agent/jobs')).text) as { id: string; finished?: number }[];
    expect(jobs.find(j => j.id === job)?.finished).toBeTypeOf('number');
  });
}
const director = { agent: 'codex', model: 'model', effort: 'low' };

describe('Studio and shared bridge lifecycle without generations', () => {
  it('runs image → feedback/selection → motion → build with replayed item events and forced work id', async () => {
    const h = harness(), p = await h.json('/__shiki/studio/projects', { title: 'Silver Tide', brief: 'quiet water' }) as Project;
    const lookJob = await h.json('/__shiki/studio/project/round', { id: p.id, stage: 'look', feedback: '', count: { gpt: 2, lora: 0 }, director: { ...director, agent: 'claude' } });
    await done(h, lookJob.job);
    const replay = await h.request(`/__shiki/agent/events?job=${lookJob.job}`);
    const events = replay.text.trim().split('\n\n').map(line => JSON.parse(line.slice(6))) as AgentEvent[];
    const states = events.filter(e => e.type === 'item').map(e => JSON.parse(e.text).status);
    expect(states.filter(s => s === 'queued')).toHaveLength(2); expect(states.filter(s => s === 'running')).toHaveLength(2); expect(states.filter(s => s === 'done')).toHaveLength(2);
    const p1 = JSON.parse((await h.request(`/__shiki/studio/project?id=${p.id}`)).text) as Project;
    const key = p1.rounds[0].items[0];
    await h.json('/__shiki/studio/project/rate', { id: p.id, item: key.id, rating: 1, note: 'もっと余白' });
    await h.json('/__shiki/studio/project/choose', { id: p.id, keyVisual: key.id });
    const motionJob = await h.json('/__shiki/studio/project/round', { id: p.id, stage: 'motion', feedback: '逆行', count: { gpt: 1, lora: 0 }, director });
    await done(h, motionJob.job);
    const p2 = JSON.parse((await h.request(`/__shiki/studio/project?id=${p.id}`)).text) as Project;
    await h.json('/__shiki/studio/project/choose', { id: p.id, studies: [p2.rounds[1].items[0].id] });
    const build = await h.json('/__shiki/studio/project/build', { id: p.id, ...director });
    await done(h, build.job);
    const p3 = JSON.parse((await h.request(`/__shiki/studio/project?id=${p.id}`)).text) as Project;
    expect(p3).toMatchObject({ stage: 'done', workId: p.id });
    const final = await h.request(`/__shiki/agent/events?job=${build.job}`);
    expect(final.text).toContain(`\\"createdWorkId\\":\\"${p.id}\\"`);
    expect(readFileSync(join(root, 'works', p.id, 'studies.md'), 'utf8')).toContain('tension');
    // New works start from the WebGPU starter, with the work id filled in, and the agent is told to build a WebGPU world.
    expect(starterSeen).toContain(`id: '${p.id}',`);
    expect(starterSeen).not.toContain('// replaced');
    const buildCall = calls.find(c => c.text.includes('Use exactly') && c.text.includes('as folder'))!;
    expect(buildCall.text).toContain('Build a WebGPU world');
    expect(buildCall.text).toContain('keep the plumbing');
    expect(buildCall.text).not.toContain('#include <shiki_image>');
    const claude = calls[0];
    expect(claude.args).toContain('--strict-mcp-config'); expect(claude.env.ECC_HOOK_PROFILE).toBe('minimal');
    expect(claude.args.slice(claude.args.indexOf('--tools') + 1, claude.args.indexOf('--allowedTools'))).toEqual(['Read']);
    const image = calls.find(c => c.text.includes('Use your built-in') && c.text.includes('first attached'))!;
    expect(image.args[image.args.indexOf('-i') + 1]).toBe(join(root, 'studio', p.id, key.file!));
    const builder = calls.at(-1)!;
    expect(builder.text).toContain(`Use exactly ${p.id} as folder`);
    expect(builder.args.filter(a => a === '-i')).toHaveLength(2);
    const file = await h.request(`/__shiki/studio/file?id=${p.id}&path=${key.file}`);
    expect(file.headers['content-type']).toBe('image/png'); expect(file.headers.etag).toBeTruthy();
    expect((await h.request(`/__shiki/studio/file?id=${p.id}&path=${key.file}`, 'GET', undefined, { 'if-none-match': String(file.headers.etag) })).status).toBe(304);
  });
  it('limits images to three, permits rating while busy, cancels every active child and marks queued items', async () => {
    holdImages = true;
    const h = harness(), p = await h.json('/__shiki/studio/projects', { title: 'Cancel', brief: 'quiet' });
    const round = await h.json('/__shiki/studio/project/round', { id: p.id, stage: 'look', count: { gpt: 5, lora: 0 }, director });
    await vi.waitFor(() => expect(calls.filter(c => c.text.includes('Use your built-in'))).toHaveLength(3));
    expect((await h.request('/__shiki/studio/project/round', 'POST', { id: p.id, stage: 'look', count: { gpt: 1, lora: 0 }, director })).status).toBe(409);
    const project = JSON.parse((await h.request(`/__shiki/studio/project?id=${p.id}`)).text) as Project;
    expect((await h.request('/__shiki/studio/project/rate', 'POST', { id: p.id, item: project.rounds[0].items[0].id, rating: 1 })).status).toBe(200);
    expect((await h.request(`/__shiki/agent/cancel?job=${round.job}`, 'POST')).status).toBe(200);
    await done(h, round.job);
    const stopped = JSON.parse((await h.request(`/__shiki/studio/project?id=${p.id}`)).text) as Project;
    expect(stopped.rounds[0].items.every(i => i.status === 'error')).toBe(true);
    expect(stopped.rounds[0].items[0].rating).toBe(1);
  });
  it('preserves legacy feedback flags, inlined notes, history snapshots and restore', async () => {
    mkdirSync(join(root, 'works/legacy'));
    writeFileSync(join(root, 'works/legacy/index.ts'), 'original');
    writeFileSync(join(root, 'works/legacy/NOTES.md'), 'legacy intent');
    const h = harness(), job = await h.json('/__shiki/agent/run', { mode: 'feedback', workId: 'legacy', message: 'more stillness', agent: 'claude', model: 'model', effort: 'high', attempt: 1 });
    await done(h, job.job);
    expect(calls[0].args).toContain('Bash(npx tsc:*)');
    expect(calls[0].text).toContain('<work-notes>\nlegacy intent');
    expect(calls[0].text).toContain('<philosophy>\nphilosophy');
    expect(readFileSync(join(root, 'works/legacy/index.ts'), 'utf8')).toBe('changed');
    const history = JSON.parse((await h.request('/__shiki/history?work=legacy')).text);
    expect(history[0]).toMatchObject({ job: job.job, attempt: 1, message: 'more stillness' });
    expect((await h.request('/__shiki/history/restore', 'POST', { work: 'legacy', version: history[0].version })).status).toBe(200);
    expect(readFileSync(join(root, 'works/legacy/index.ts'), 'utf8')).toBe('original');
  });
  it('recovers a missing target from generated_images without reusing a prior result', async () => {
    imageFallback = true; vi.stubEnv('CODEX_HOME', join(root, '.codex'));
    const job: Job = { id: 'image-test', ...director, agent: 'codex', mode: 'create', workId: null, message: '', keyVisual: false, attempt: 0, state: 'running', events: [], listeners: new Set(), procs: new Set(), abort: new AbortController(), started: Date.now() };
    const target = join(root, 'image.png');
    await generateGpt(job, root, 'scene', target, [], false);
    expect(readFileSync(target)).toEqual(png);
    skipImage = true;
    await expect(generateGpt(job, root, 'scene', join(root, 'missing.png'), [], false)).rejects.toThrow('did not save');
    vi.unstubAllEnvs();
  });
  it('starts an installed LoRA service with the required uv groups and tracks it for cancellation', async () => {
    const dir = join(root, 'lora'); mkdirSync(join(dir, 'scripts'), { recursive: true });
    writeFileSync(join(dir, 'scripts/10_ui_server.py'), '# fake');
    const job: Job = { id: 'lora-test', ...director, agent: 'codex', mode: 'create', workId: null, message: '', keyVisual: false, attempt: 0, state: 'running', events: [], listeners: new Set(), procs: new Set(), abort: new AbortController(), started: Date.now() };
    let requests = 0;
    const transport: typeof fetch = async () => {
      if (++requests === 1) throw new Error('stopped');
      return new Response(JSON.stringify({ phase: requests === 2 ? 'loading' : 'idle', message: '', results: [] }));
    };
    await new LoraClient(root, 'http://127.0.0.1:7860', 1, 100, dir, transport).start(job);
    expect(calls[0]).toMatchObject({ command: 'uv', args: ['run', '--group', 'eval', '--group', 'ui', 'scripts/10_ui_server.py'] });
    expect(job.procs.size).toBe(1);
    cancelJob(job); expect(calls[0].proc.kill).toHaveBeenCalled();
  });
  it('rejects malformed requests, invalid selections, missing build inputs and unsafe files', async () => {
    const h = harness(), p = await h.json('/__shiki/studio/projects', { title: 'Validate', brief: 'quiet' });
    expect((await h.request('/__shiki/studio/project/build', 'POST', { id: p.id, ...director })).status).toBe(400);
    expect((await h.request('/__shiki/studio/project/round', 'POST', { id: p.id, stage: 'motion', director })).status).toBe(400);
    expect((await h.request('/__shiki/studio/project/round', 'POST', { id: p.id, stage: 'done', director })).status).toBe(400);
    expect((await h.request('/__shiki/studio/project/refs', 'POST', { id: p.id, refs: ['data:image/png;base64,AAAA'] })).status).toBe(400);
    expect((await h.request(`/__shiki/studio/file?id=${p.id}&path=../project.json`)).status).toBe(400);
    expect((await h.request('/__shiki/studio/projects', 'POST', [])).status).toBe(400);
    expect((await h.request('/__shiki/studio/project/update', 'GET')).status).toBe(405);
  });
});
