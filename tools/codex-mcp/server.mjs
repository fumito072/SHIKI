#!/usr/bin/env node
// shiki-codex — a minimal MCP server (stdio, JSON-RPC 2.0) that exposes the Codex harness
// (tools/agents/codex-run.sh) to Claude Code. Codex runs in the background; poll with codex_status.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const RUNS = join(ROOT, '.agents/runs');
const BRIEFS = join(ROOT, '.agents/briefs');
const RUNNER = join(ROOT, 'tools/agents/codex-run.sh');

const tools = [
  {
    name: 'codex_start',
    description:
      'Start a Codex task in the SHIKI repo (background). Give a self-contained brief: owned files, interface, acceptance criteria. Returns a run id.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'short task name, kebab-case' },
        brief: { type: 'string', description: 'full task brief (markdown)' },
        effort: { type: 'string', enum: ['low', 'medium', 'high'], default: 'medium' },
        images: { type: 'array', items: { type: 'string' }, description: 'repo-relative image paths to attach' },
      },
      required: ['name', 'brief'],
    },
  },
  {
    name: 'codex_status',
    description: 'Status of a Codex run (running / exit code) and the tail of its log. Without run, lists recent runs.',
    inputSchema: { type: 'object', properties: { run: { type: 'string' }, lines: { type: 'number', default: 30 } } },
  },
  {
    name: 'codex_result',
    description: "Codex's final message for a finished run.",
    inputSchema: { type: 'object', properties: { run: { type: 'string' } }, required: ['run'] },
  },
  {
    name: 'codex_image',
    description: "Generate an image with Codex's built-in image tool (GPT Image) and save it at a repo-relative path.",
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        prompt: { type: 'string', description: 'what to draw (art direction, composition, palette)' },
        out: { type: 'string', description: 'repo-relative output path, e.g. design/key-visuals/kv12-x.png' },
        size: { type: 'string', default: '1536x1024' },
      },
      required: ['name', 'prompt', 'out'],
    },
  },
];

function startRun(name, brief, effort = 'medium', images = []) {
  const safe = String(name).replace(/[^a-z0-9-]/gi, '-').slice(0, 48) || 'task';
  mkdirSync(BRIEFS, { recursive: true });
  const briefPath = join(BRIEFS, `${Date.now()}-${safe}.md`);
  writeFileSync(briefPath, brief);
  const args = [RUNNER, safe, briefPath, effort];
  if (images.length) args.push('--', ...images);
  const child = spawn('bash', args, { cwd: ROOT, detached: true, stdio: 'ignore' });
  child.unref();
  return safe;
}

function findRun(id) {
  if (!existsSync(RUNS)) return null;
  const dirs = readdirSync(RUNS).filter((d) => d.endsWith(`-${id}`) || d === id).sort();
  return dirs.length ? join(RUNS, dirs[dirs.length - 1]) : null;
}

function read(path) {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

const handlers = {
  codex_start({ name, brief, effort, images }) {
    const id = startRun(name, brief, effort, images ?? []);
    return `started: ${id}\nPoll with codex_status { run: "${id}" }.`;
  },
  codex_status({ run, lines = 30 }) {
    if (!run) {
      const all = existsSync(RUNS) ? readdirSync(RUNS).sort().slice(-10) : [];
      return all.length ? all.map((d) => `${d} — ${existsSync(join(RUNS, d, 'exit')) ? `exit ${read(join(RUNS, d, 'exit')).trim()}` : 'running'}`).join('\n') : 'no runs';
    }
    const dir = findRun(run);
    if (!dir) return `no run named ${run} (it may still be starting)`;
    const exit = read(join(dir, 'exit')).trim();
    const tail = read(join(dir, 'log.txt')).split('\n').slice(-lines).join('\n');
    return `${dir}\nstatus: ${exit ? `finished (exit ${exit})` : 'running'}\n--- log tail ---\n${tail}`;
  },
  codex_result({ run }) {
    const dir = findRun(run);
    if (!dir) return `no run named ${run}`;
    return read(join(dir, 'result.md')) || 'no result yet';
  },
  codex_image({ name, prompt, out, size = '1536x1024' }) {
    const brief = [
      'Use your built-in image generation tool (gpt-image) to create one image.',
      `Size: ${size}.`,
      `Prompt: ${prompt}`,
      `Save it at the repo-relative path ${out} (create folders if needed). Do not edit any other file.`,
      'Final message: the absolute path and pixel size.',
    ].join('\n');
    const id = startRun(name, brief, 'low');
    return `started: ${id}\nPoll with codex_status { run: "${id}" }.`;
  },
};

function send(msg) {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
  }
  const { id, method, params } = msg;
  if (id === undefined) return; // notification
  try {
    if (method === 'initialize') {
      return send({
        jsonrpc: '2.0',
        id,
        result: {
          protocolVersion: params?.protocolVersion ?? '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'shiki-codex', version: '0.1.0' },
        },
      });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools } });
    if (method === 'tools/call') {
      const fn = handlers[params?.name];
      if (!fn) return send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: `unknown tool ${params?.name}` }] } });
      const text = fn(params.arguments ?? {});
      return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } });
  } catch (err) {
    send({ jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: String(err) }] } });
  }
});
