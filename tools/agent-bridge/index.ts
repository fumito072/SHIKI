// SHIKI agent bridge — dev-server endpoints that let the performer create works and give feedback from the UI.
// Runs the user's own subscription CLIs (`claude`, `codex`) inside the repo; API-key env vars are stripped so the
// logged-in subscriptions are used. Dev only (Vite `apply: 'serve'`), bound to localhost by Vite.
import type { Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { execFile, spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);

type AgentId = 'claude' | 'codex';
type Mode = 'create' | 'feedback';

export interface AgentEvent {
  type: 'status' | 'text' | 'tool' | 'error' | 'done';
  text: string;
  at: number;
}

interface Job {
  id: string;
  agent: AgentId;
  model: string;
  effort: string;
  mode: Mode;
  workId: string | null;
  message: string;
  /** Create mode: start from a generated key visual (Codex image generation). */
  keyVisual: boolean;
  /** Automatic repair round sent by the Studio (0 = the user's own request). */
  attempt: number;
  state: 'running' | 'done' | 'error' | 'cancelled';
  createdWorkId?: string;
  events: AgentEvent[];
  listeners: Set<ServerResponse>;
  proc?: ChildProcess;
  started: number;
}

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

/**
 * Subscription login only: drop API keys / base URLs and the markers of a parent Claude Code session
 * (the dev server may itself have been started from one), keeping only where the CLI config lives.
 */
function agentEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE)/.test(k) && k !== 'CLAUDE_CONFIG_DIR') delete env[k];
  return env;
}

function worksIn(root: string): string[] {
  const dir = join(root, 'works');
  return existsSync(dir) ? readdirSync(dir).filter((d) => !d.startsWith('.')) : [];
}

function prompt(job: Job, framePath: string | null): string {
  const target = job.mode === 'create' ? 'a NEW work' : `the work in works/${job.workId}/`;
  return [
    'You are an artist-engineer inside SHIKI, a real-time audio-reactive visual instrument for VJ performance.',
    'The human only gives briefs and feedback; you make the work.',
    `Read first: AGENTS.md (instrument contract, shader conventions, artistic intent), docs/philosophy.md (the user's aim — it overrides polish), docs/taste.md (the user's cross-work preferences)${job.workId ? `, works/${job.workId}/NOTES.md if it exists (this work's direction and history)` : ''}.`,
    job.mode === 'create'
      ? 'Task: create a new work from the brief below. Choose a short lowercase id (a-z, 0-9, -) and create works/<id>/ following the instrument contract (index.ts + shaders); manifest.id must equal the folder name. Include works/<id>/NOTES.md with the concept, the choreography (kick, anticipation, tension, drop) and the macros.'
      : `Task: change ${target} according to the feedback below.`,
    job.mode === 'create' && job.keyVisual
      ? 'Image first: before writing code, generate one key visual (16:9) for the concept with your image generation tool, copy it to works/<id>/keyvisual.png, describe what makes it strong (composition, light, palette, texture) in NOTES.md, then build the instrument so a still frame reads like that image and its motion follows the choreography.'
      : '',
    `Edit only files inside ${job.mode === 'create' ? 'the new work folder' : target}. If the feedback states a general preference (not specific to this work), append one dated bullet to docs/taste.md.`,
    "Update the work's NOTES.md: what the user asked, what you changed, what to avoid next time.",
    'Never just vibrate with the audio: drive choreography (tension → release, inertia, anticipation, boundary breaks).',
    'GLSL is compiled at runtime, not by tsc: copy the plumbing of works/moonsea (fullscreen fragment shaders declare `varying vec2 vUv;` themselves). After you finish, the platform compiles the work in the live preview and sends any error back to you.',
    'Before finishing run `npx tsc --noEmit` and fix errors in your files. Do not commit, do not start servers.',
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

function spawnAgent(job: Job, text: string, root: string, framePath: string | null): ChildProcess {
  const env = agentEnv();
  if (job.agent === 'claude') {
    // The prompt goes through stdin: no argv length limit, and stray control bytes cannot break the spawn.
    const args = [
      '-p',
      '--model', job.model,
      '--effort', job.effort,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash(npx tsc:*)', 'Bash(npx vitest:*)',
    ];
    const p = spawn('claude', args, { cwd: root, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    p.stdin?.end(text);
    return p;
  }
  const args = ['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-C', root, '-m', job.model, '-c', `model_reasoning_effort=${job.effort}`, '--json'];
  if (framePath) args.push('-i', framePath);
  args.push('-');
  const p = spawn('codex', args, { cwd: root, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  p.stdin?.end(text);
  return p;
}

/** Turns one JSON line from either CLI into display events. */
function toEvents(agent: AgentId, o: Record<string, unknown>): Omit<AgentEvent, 'at'>[] {
  const out: Omit<AgentEvent, 'at'>[] = [];
  if (agent === 'claude') {
    if (o.type === 'assistant') {
      const content = ((o.message as { content?: unknown[] } | undefined)?.content ?? []) as Record<string, unknown>[];
      for (const c of content) {
        if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) out.push({ type: 'text', text: c.text.trim() });
        if (c.type === 'tool_use') {
          const input = (c.input ?? {}) as Record<string, unknown>;
          const what = (input.file_path ?? input.path ?? input.command ?? input.pattern ?? '') as string;
          out.push({ type: 'tool', text: `${String(c.name)} ${String(what).replace(/^.*\/shiki\//, '')}`.trim() });
        }
      }
    } else if (o.type === 'result') {
      if (o.is_error) out.push({ type: 'error', text: String(o.result ?? 'error') });
    }
    return out;
  }
  // codex --json
  const item = o.item as Record<string, unknown> | undefined;
  if (o.type === 'item.completed' && item) {
    if (item.type === 'agent_message' && typeof item.text === 'string') out.push({ type: 'text', text: item.text.trim() });
    else if (item.type === 'command_execution') out.push({ type: 'tool', text: `$ ${String(item.command ?? '')}`.slice(0, 200) });
    else if (item.type === 'file_change') {
      const changes = (item.changes as { path?: string }[] | undefined) ?? [];
      out.push({ type: 'tool', text: `edit ${changes.map((c) => String(c.path ?? '').replace(/^.*\/shiki\//, '')).join(', ')}` });
    } else if (item.type === 'reasoning' && typeof item.text === 'string') out.push({ type: 'status', text: item.text.trim().slice(0, 200) });
  } else if (o.type === 'error' || o.type === 'turn.failed') {
    out.push({ type: 'error', text: JSON.stringify(o.error ?? o.message ?? o).slice(0, 400) });
  }
  return out;
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

  return {
    name: 'shiki-agent-bridge',
    apply: 'serve',
    configResolved(config) {
      root = config.root;
    },
    configureServer(server) {
      server.middlewares.use('/__shiki/agent/options', async (_req, res) => send(res, 200, await options()));

      server.middlewares.use('/__shiki/agent/jobs', (_req, res) =>
        send(res, 200, [...jobs.values()].slice(-20).map(({ proc: _p, listeners: _l, events, ...j }) => ({ ...j, last: events.at(-1) }))),
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
        const busy = [...jobs.values()].find((j) => j.state === 'running' && j.workId === workId && workId !== null);
        if (busy) return send(res, 409, { error: `${workId} is already being edited`, job: busy.id });

        const id = `${Date.now().toString(36)}-${agent}`;
        const keyVisual = mode === 'create' && b.keyVisual === true;
        const attempt = typeof b.attempt === 'number' ? b.attempt : 0;
        const job: Job = { id, agent, model, effort, mode, workId, message, keyVisual, attempt, state: 'running', events: [], listeners: new Set(), started: Date.now() };
        jobs.set(id, job);

        const jobDir = join(root, '.agents/studio', id);
        mkdirSync(jobDir, { recursive: true });
        let framePath: string | null = null;
        if (typeof b.snapshot === 'string' && b.snapshot.startsWith('data:image/')) {
          framePath = join(jobDir, 'frame.jpg');
          writeFileSync(framePath, Buffer.from(b.snapshot.replace(/^data:image\/\w+;base64,/, ''), 'base64'));
        }
        if (mode === 'feedback' && workId) snapshot(workId, { job: id, agent, model, effort, message, attempt });
        const before = new Set(worksIn(root));

        emit(job, { type: 'status', text: `${agent} · ${model} · ${effort} で開始` });
        let proc: ChildProcess;
        try {
          proc = spawnAgent(job, prompt(job, framePath), root, framePath);
        } catch (err) {
          job.state = 'error';
          emit(job, { type: 'error', text: String(err) });
          return send(res, 200, { job: id });
        }
        job.proc = proc;
        let buf = '';
        let finalText = '';
        proc.stdout?.on('data', (chunk: Buffer) => {
          buf += chunk.toString();
          let nl: number;
          while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            try {
              for (const e of toEvents(agent, JSON.parse(line) as Record<string, unknown>)) {
                if (e.type === 'text') finalText = e.text;
                emit(job, e);
              }
            } catch {
              /* non-JSON noise */
            }
          }
        });
        let errTail = '';
        proc.stderr?.on('data', (chunk: Buffer) => {
          errTail = (errTail + chunk.toString()).slice(-2000);
        });
        proc.on('close', (code) => {
          if (job.state === 'cancelled') {
            emit(job, { type: 'done', text: '中止しました' });
          } else if (code === 0) {
            job.state = 'done';
            if (mode === 'create') job.createdWorkId = worksIn(root).find((w) => !before.has(w));
            emit(job, { type: 'done', text: JSON.stringify({ summary: finalText, createdWorkId: job.createdWorkId ?? null }) });
          } else {
            job.state = 'error';
            emit(job, { type: 'error', text: `exit ${code}\n${errTail.trim().split('\n').slice(-6).join('\n')}` });
          }
          for (const r of job.listeners) r.end();
          job.listeners.clear();
        });
        send(res, 200, { job: id });
      });

      server.middlewares.use('/__shiki/agent/events', (req, res) => {
        const id = new URL(req.url ?? '/', 'http://local').searchParams.get('job') ?? '';
        const job = jobs.get(id);
        if (!job) return send(res, 404, { error: 'no such job' });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        for (const e of job.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
        if (job.state !== 'running') return void res.end();
        job.listeners.add(res);
        req.on('close', () => job.listeners.delete(res));
      });

      server.middlewares.use('/__shiki/agent/cancel', (req, res) => {
        const id = new URL(req.url ?? '/', 'http://local').searchParams.get('job') ?? '';
        const job = jobs.get(id);
        if (!job || job.state !== 'running') return send(res, 404, { error: 'not running' });
        job.state = 'cancelled';
        try {
          if (job.proc?.pid) process.kill(-job.proc.pid, 'SIGTERM');
        } catch {
          job.proc?.kill('SIGTERM');
        }
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
