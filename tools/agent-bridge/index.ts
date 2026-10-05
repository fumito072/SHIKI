// SHIKI agent bridge — dev-server endpoints that let the performer create works and give feedback from the UI.
// Runs the user's own subscription CLIs (`claude`, `codex`) inside the repo; API-key env vars are stripped so the
// logged-in subscriptions are used. Dev only (Vite `apply: 'serve'`), bound to localhost by Vite.
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';

import type { AgentId, AgentEvent, Job, Mode } from './pipeline/types';
import { agentEnv } from './pipeline/agents';
import { runAgent, finishJob, cancelJob } from './pipeline/jobs';
import { installPipeline } from './pipeline/api';
export type { AgentEvent } from './pipeline/types';

const exec = promisify(execFile);

interface ModelOption {
  id: string;
  label: string;
  efforts: string[];
}

const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const CLAUDE_MODELS: ModelOption[] = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1', efforts: CLAUDE_EFFORTS },
  { id: 'claude-opus-5-5', label: 'Opus 5.5', efforts: CLAUDE_EFFORTS },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', efforts: CLAUDE_EFFORTS },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5', efforts: CLAUDE_EFFORTS },
];

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        done(JSON.parse(Buffer.concat(chunks).toString() || '{}'));
      } catch {
        done({});
      }
    });
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}

function worksIn(root: string): string[] {
  const dir = join(root, 'works');
  return existsSync(dir) ? readdirSync(dir).filter((d) => !d.startsWith('.')) : [];
}

function readIf(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim();
  } catch {
    return null;
  }
}

/**
 * The context docs are inlined (each "read this first" costs the agent a turn). AGENTS.md is not: both CLIs load it
 * as project instructions on their own.
 */
function prompt(job: Job, framePath: string | null, root: string): string {
  const target = job.mode === 'create' ? 'a NEW work' : `the work in works/${job.workId}/`;
  const doc = (title: string, body: string | null) => (body ? `<${title}>\n${body}\n</${title}>` : '');
  const notes = job.workId
    ? readIf(join(root, 'works', job.workId, 'NOTES.md')) ?? readIf(join(root, 'works', job.workId, 'README.md'))
    : null;
  // WebGPU worlds (three/webgpu + TSL) and WebGL works (GLSL) need different plumbing advice. New works are WebGPU.
  const gpu = job.mode === 'create' || !job.workId || /defineGpuInstrument/.test(readIf(join(root, 'works', job.workId, 'index.ts')) ?? '');
  return [
    'You are an artist-engineer inside SHIKI, a real-time audio-reactive visual instrument for VJ performance.',
    'The human only gives briefs and feedback; you make the work.',
    'AGENTS.md (instrument contract, shader conventions, artistic intent) is already in your instructions. The documents below are their current contents — read them again only to edit them.',
    doc('philosophy', readIf(join(root, 'docs/philosophy.md'))),
    doc('taste', readIf(join(root, 'docs/taste.md'))),
    doc('work-notes', notes),
    job.kind === 'build'
      ? `Task: create the instrument in works/${job.workId}/. The folder already contains approved images. Use exactly ${job.workId} as folder and manifest.id; keep the images. Include NOTES.md with concept, choreography and macros.`
      : job.mode === 'create'
      ? 'Task: create a new work from the brief below. Choose a short lowercase id (a-z, 0-9, -) and create works/<id>/ as a WebGPU world: copy works/_starter/index.ts to works/<id>/index.ts as the plumbing, set manifest.id to the folder name, then replace its placeholder world (without a key visual, remove the image import and keyImage of the starter). Include works/<id>/NOTES.md with the concept, the choreography (kick, anticipation, tension, drop) and the macros.'
      : `Task: change ${target} according to the feedback below.`,
    job.mode === 'create' && job.keyVisual
      ? 'Image first: before writing code, generate one key visual (16:9) for the concept with your image generation tool, copy it to works/<id>/keyvisual.png (import that file instead of the starter\'s keyvisual.jpg), describe what makes it strong (composition, light, palette, texture) in NOTES.md, then build the instrument so a still frame reads like that image and its motion follows the choreography.'
      : '',
    `Edit only files inside ${job.kind === 'build' ? `works/${job.workId}/` : job.mode === 'create' ? 'the new work folder' : target}. If the feedback states a general preference (not specific to this work), append one dated bullet to docs/taste.md.`,
    "Update the work's NOTES.md: what the user asked, what you changed, what to avoid next time.",
    'Never just vibrate with the audio: drive choreography (tension → release, inertia, anticipation, boundary breaks).',
    gpu
      ? 'This is a WebGPU world (see "WebGPU worlds" in AGENTS.md): three/webgpu + TSL node materials only, no GLSL or ShaderMaterial; keep its Director, light events and models. Shader nodes compile at runtime: after you finish, the platform loads the work in the live preview and sends any error back to you.'
      : 'GLSL is compiled at runtime, not by tsc: copy the plumbing of works/moonsea (fullscreen fragment shaders declare `varying vec2 vUv;` themselves). After you finish, the platform compiles the work in the live preview and sends any error back to you.',
    'Before finishing run `npx tsc --noEmit` and fix errors in your files. Do not commit, do not start servers.',
    'Shell commands you may run: npx tsc --noEmit, npm run typecheck, npx vitest run <path>, npm test, ls. Anything else is refused — use Read / Glob / Grep instead. Nobody approves anything during the run.',
    framePath
      ? `The frame the user is looking at right now: ${framePath}${job.agent === 'claude' ? ' (open it with the Read tool).' : ' (attached).'}`
      : '',
    'Final reply: 3–6 short lines in Japanese — what you changed and what the user should look for.',
    '',
    '--- user message ---',
    job.message,
  ]
    .filter(Boolean)
    .join('\n');
}

export function agentBridge(): Plugin {
  const jobs = new Map<string, Job>();
  let root = process.cwd();
  let codexModels: ModelOption[] | null = null;

  const emit = (job: Job, e: Omit<AgentEvent, 'at'>) => {
    const ev: AgentEvent = { ...e, at: Date.now() };
    job.events.push(ev);
    for (const res of job.listeners) res.write(`data: ${JSON.stringify(ev)}\n\n`);
  };

  async function options() {
    if (!codexModels) {
      try {
        const { stdout } = await exec('codex', ['debug', 'models'], { env: agentEnv(), maxBuffer: 8 * 1024 * 1024 });
        const data = JSON.parse(stdout) as unknown;
        const items = (Array.isArray(data) ? data : ((data as { models?: unknown[] }).models ?? [])) as Record<string, unknown>[];
        codexModels = items
          .filter((m) => typeof m.slug === 'string' && m.visibility !== 'hide')
          .map((m) => ({
            id: String(m.slug),
            label: String(m.display_name ?? m.slug),
            efforts: ((m.supported_reasoning_levels as { effort: string }[] | undefined) ?? []).map((l) => l.effort),
          }));
      } catch {
        codexModels = [];
      }
    }
    let defaultCodex = codexModels[0]?.id ?? '';
    try {
      const cfg = readFileSync(join(process.env.HOME ?? '', '.codex/config.toml'), 'utf8');
      defaultCodex = /^model\s*=\s*"([^"]+)"/m.exec(cfg)?.[1] ?? defaultCodex;
    } catch {
      /* no config */
    }
    return {
      claude: { models: CLAUDE_MODELS, default: { model: CLAUDE_MODELS[0].id, effort: 'high' } },
      codex: { models: codexModels, default: { model: defaultCodex, effort: 'high' } },
    };
  }

  function historyDir(work: string) {
    return join(root, '.agents/history', work);
  }

  function snapshot(work: string, note: Record<string, unknown>): string {
    const version = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = join(historyDir(work), version);
    mkdirSync(dir, { recursive: true });
    cpSync(join(root, 'works', work), join(dir, 'files'), { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ ...note, at: Date.now() }));
    return version;
  }

  async function launchWork(job: Job, images: string[]): Promise<string> {
    const before = new Set(worksIn(root));
    emit(job, { type: 'status', text: `${job.agent} · ${job.model} · ${job.effort} で開始` });
    const text = prompt(job, images[0] ?? null, root) + (images.length ? `\nApproved attached images (Claude: open each with Read):\n${images.join('\n')}` : '');
    const summary = await runAgent(job, emit, root, text, images);
    if (job.kind === 'build' && job.workId) {
      if (!existsSync(join(root, 'works', job.workId, 'index.ts'))) throw new Error('Build did not create index.ts');
      job.createdWorkId = job.workId;
    } else if (job.mode === 'create') job.createdWorkId = worksIn(root).find(w => !before.has(w));
    return summary;
  }

  return {
    name: 'shiki-agent-bridge',
    apply: 'serve',
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      installPipeline(server.middlewares, root, jobs, emit, launchWork, snapshot);
      server.middlewares.use('/__shiki/agent/options', async (_req, res) => send(res, 200, await options()));

      server.middlewares.use('/__shiki/agent/jobs', (_req, res) =>
        send(res, 200, [...jobs.values()].slice(-20).map(({ procs: _p, abort: _a, listeners: _l, events, ...j }) => ({ ...j, last: events.at(-1) }))),
      );

      server.middlewares.use('/__shiki/agent/run', async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
        const b = await readJson(req);
        const agent: AgentId = b.agent === 'codex' ? 'codex' : 'claude';
        const mode: Mode = b.mode === 'create' ? 'create' : 'feedback';
        const workId = typeof b.workId === 'string' && ID.test(b.workId) ? b.workId : null;
        // WebGL info logs (sent back by automatic repairs) carry NUL bytes; drop all control characters but newlines/tabs.
        const message = String(b.message ?? '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
        const model = String(b.model ?? '').trim();
        const effort = String(b.effort ?? '').trim();
        if (!message) return send(res, 400, { error: 'message is empty' });
        if (!/^[\w.:-]+$/.test(model) || !/^[a-z]+$/.test(effort)) return send(res, 400, { error: 'bad model or effort' });
        if (mode === 'feedback' && (!workId || !existsSync(join(root, 'works', workId)))) return send(res, 400, { error: 'unknown work' });
        const busy = [...jobs.values()].find((j) => (j.state === 'running' || (j.state === 'cancelled' && !j.finished)) && j.workId === workId && workId !== null);
        if (busy) return send(res, 409, { error: `${workId} is already being edited`, job: busy.id });

        const id = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}-${agent}`;
        const keyVisual = mode === 'create' && b.keyVisual === true;
        const attempt = typeof b.attempt === 'number' ? b.attempt : 0;
        const job: Job = { id, agent, model, effort, mode, workId, message, keyVisual, attempt, state: 'running', events: [], listeners: new Set(), procs: new Set(), abort: new AbortController(), started: Date.now() };
        jobs.set(id, job);

        const jobDir = join(root, '.agents/studio', id);
        mkdirSync(jobDir, { recursive: true });
        let framePath: string | null = null;
        if (typeof b.snapshot === 'string' && b.snapshot.startsWith('data:image/')) {
          framePath = join(jobDir, 'frame.jpg');
          writeFileSync(framePath, Buffer.from(b.snapshot.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
        }
        if (mode === 'feedback' && workId) snapshot(workId, { job: id, agent, model, effort, message, attempt });
        void launchWork(job, framePath ? [framePath] : []).then(
          summary => finishJob(job, emit, undefined, summary),
          error => finishJob(job, emit, error),
        );
        send(res, 200, { job: id });
      });

      server.middlewares.use('/__shiki/agent/events', (req, res) => {
        const id = new URL(req.url ?? '/', 'http://local').searchParams.get('job') ?? '';
        const job = jobs.get(id);
        if (!job) return send(res, 404, { error: 'no such job' });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        for (const e of job.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
        if (job.finished) return void res.end();
        job.listeners.add(res);
        res.on('close', () => job.listeners.delete(res));
      });

      server.middlewares.use('/__shiki/agent/cancel', (req, res) => {
        const id = new URL(req.url ?? '/', 'http://local').searchParams.get('job') ?? '';
        const job = jobs.get(id);
        if (!job || job.state !== 'running') return send(res, 404, { error: 'not running' });
        cancelJob(job);
        send(res, 200, { ok: true });
      });

      server.middlewares.use('/__shiki/history/restore', async (req, res) => {
        if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });
        const b = await readJson(req);
        const work = String(b.work ?? '');
        const version = String(b.version ?? '');
        const src = join(historyDir(work), version, 'files');
        if (!ID.test(work) || !/^[\w-]+$/.test(version) || !existsSync(src)) return send(res, 400, { error: 'unknown version' });
        snapshot(work, { restore: true, restoredFrom: version });
        const dest = join(root, 'works', work);
        rmSync(dest, { recursive: true, force: true });
        cpSync(src, dest, { recursive: true });
        send(res, 200, { ok: true });
      });

      server.middlewares.use('/__shiki/history', (req, res) => {
        const work = new URL(req.url ?? '/', 'http://local').searchParams.get('work') ?? '';
        if (!ID.test(work) || !existsSync(historyDir(work))) return send(res, 200, []);
        const list = readdirSync(historyDir(work))
          .sort()
          .reverse()
          .slice(0, 30)
          .map((version) => {
            let meta: Record<string, unknown> = {};
            try {
              meta = JSON.parse(readFileSync(join(historyDir(work), version, 'meta.json'), 'utf8')) as Record<string, unknown>;
            } catch {
              /* missing meta */
            }
            return { version, ...meta };
          });
        send(res, 200, list);
      });
    },
  };
}
