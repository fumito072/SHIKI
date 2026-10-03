import type { Connect } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import type { Director, Job } from './types';
import { InputError, Store, stringInput } from './store';
import { stageImages, validateCounts, validateDirector } from './director';
import { finishJob } from './jobs';
import type { Emit } from './jobs';
import { LoraClient } from './lora';
import { runRound } from './round';
import { buildInputs, prepareBuild } from './build';

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 100 * 1024 * 1024) throw new InputError('Request exceeds 100 MB', 413);
    chunks.push(Buffer.from(chunk));
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw new InputError('Invalid JSON body'); }
}
function send(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(value));
}

export function installPipeline(middleware: Connect.Server, root: string, jobs: Map<string, Job>, emit: Emit,
  launchWork: (job: Job, images: string[]) => Promise<string>, snapshot: (work: string, note: Record<string, unknown>) => string) {
  const store = new Store(root), lora = new LoraClient(root);
  try {
    store.recover();
  } catch {
    /* a broken project.json must not stop the dev server */
  }
  const idle = (id: string) => {
    const busy = [...jobs.values()].find(j => (j.state === 'running' || (j.state === 'cancelled' && !j.finished)) && (j.projectId === id || j.workId === id));
    if (busy) throw new InputError(`Project is busy (job ${busy.id})`, 409);
  };
  const newJob = (id: string, director: Director, kind: 'round' | 'build') => {
    const job: Job = { id: `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}-${director.agent}`, ...director,
      mode: 'create', kind, projectId: id, workId: id, message: '', keyVisual: false, attempt: 0,
      state: 'running', events: [], listeners: new Set(), procs: new Set(), abort: new AbortController(), started: Date.now() };
    jobs.set(job.id, job); return job;
  };
  middleware.use('/__shiki/studio', (req, res, next) => {
    const url = new URL(req.url ?? '/', 'http://local'), path = url.pathname.replace(/^\//, '');
    const methods: Record<string, string> = { projects: 'GET|POST', project: 'GET', 'project/update': 'POST', 'project/refs': 'POST', 'project/refs/remove': 'POST', 'project/round': 'POST', 'project/rate': 'POST', 'project/choose': 'POST', 'project/build': 'POST', file: 'GET', 'lora/status': 'GET', 'lora/start': 'POST' };
    if (!methods[path]) return next();
    void (async () => {
      if (!methods[path].split('|').includes(req.method ?? '')) return send(res, 405, { error: `${methods[path]} only` });
      if (path === 'projects' && req.method === 'GET') return send(res, 200, store.list());
      if (path === 'project') return send(res, 200, store.get(url.searchParams.get('id')));
      if (path === 'file') {
        store.get(url.searchParams.get('id'));
        const { file, type } = store.image(url.searchParams.get('id'), url.searchParams.get('path'));
        const stat = statSync(file), etag = `"${stat.size}-${stat.mtimeMs}"`;
        res.setHeader('content-type', type);
        res.setHeader('cache-control', 'private, max-age=0, must-revalidate');
        res.setHeader('etag', etag);
        res.setHeader('x-content-type-options', 'nosniff');
        if (req.headers['if-none-match'] === etag) return void res.writeHead(304).end();
        res.setHeader('content-length', stat.size);
        const stream = createReadStream(file);
        stream.on('error', () => res.destroy()); stream.pipe(res); return;
      }
      if (path === 'lora/status') return send(res, 200, await lora.status());
      if (path === 'lora/start') { await lora.start(); return send(res, 200, await lora.status()); }
      const b = await body(req);
      if (path === 'projects') return send(res, 200, store.create(b.title, b.brief, b.refs, b.slug));
      const project = store.get(b.id);
      if (path === 'project/update') return send(res, 200, store.update(project.id, b.title, b.brief));
      if (path === 'project/rate') return send(res, 200, store.rate(project.id, b.item, b.rating, b.note));
      idle(project.id);
      if (path === 'project/refs') return send(res, 200, store.addRefs(project.id, b.refs));
      if (path === 'project/refs/remove') return send(res, 200, store.removeRef(project.id, b.path));
      if (path === 'project/choose') return send(res, 200, store.choose(project.id, b.keyVisual, b.studies));
      if (path === 'project/round') {
        if (b.stage !== 'look' && b.stage !== 'motion') throw new InputError('Invalid round stage');
        const stage = b.stage, feedback = stringInput(b.feedback === undefined ? '' : b.feedback, 'feedback', 100000, true);
        const count = validateCounts(b.count, stage), director = validateDirector(b.director);
        if (b.lora !== undefined && (!b.lora || typeof b.lora !== 'object' || Array.isArray(b.lora))) throw new InputError('Invalid lora options');
        const suppliedWeight = (b.lora as { weight?: unknown } | undefined)?.weight;
        const weight = suppliedWeight === undefined ? .75 : suppliedWeight;
        if (typeof weight !== 'number' || !Number.isFinite(weight) || weight < 0 || weight > 2) throw new InputError('LoRA weight must be 0–2');
        stageImages(project, stage).forEach(file => store.image(project.id, file));
        const job = newJob(project.id, director, 'round');
        void runRound(store, project, { stage, feedback, count, director, weight }, job, emit, lora).then(
          summary => finishJob(job, emit, undefined, summary), error => finishJob(job, emit, error),
        );
        return send(res, 200, { job: job.id });
      }
      if (path === 'project/build') {
        const director = validateDirector(b); buildInputs(store, project);
        const job = newJob(project.id, director, 'build');
        project.stage = 'build'; store.save(project);
        void (async () => {
          if (existsSync(join(root, 'works', project.id))) snapshot(project.id, { job: job.id, agent: job.agent, model: job.model, effort: job.effort, pipeline: true });
          const images = await prepareBuild(store, project, job);
          const summary = await launchWork(job, images);
          job.abort.signal.throwIfAborted();
          const p = store.get(project.id); p.stage = 'done'; p.workId = p.id; store.save(p);
          return summary;
        })().then(summary => finishJob(job, emit, undefined, summary), error => {
          const p = store.get(project.id); p.stage = 'motion'; store.save(p);
          finishJob(job, emit, error);
        });
        return send(res, 200, { job: job.id });
      }
    })().catch(error => {
      if (!res.headersSent) send(res, error instanceof InputError ? error.status : 500, { error: error instanceof Error ? error.message : String(error) });
      else res.destroy();
    });
  });
}
