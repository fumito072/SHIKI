import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { Director, Item, Job, Project, Round } from './types';
import { Store } from './store';
import { directorPrompt, parseDirector, stageImages } from './director';
import type { Counts } from './director';
import { runAgent } from './jobs';
import type { Emit } from './jobs';
import { generateGpt } from './images';
import { LoraClient } from './lora';

let activeGpt = 0;
const waiters: { resolve: () => void; reject: (error: unknown) => void; signal: AbortSignal; abort: () => void }[] = [];
async function gptSlot<T>(signal: AbortSignal, task: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  if (activeGpt < 3) activeGpt++;
  else await new Promise<void>((resolve, reject) => {
    const waiter = { resolve, reject, signal, abort: () => {
      const n = waiters.indexOf(waiter);
      if (n >= 0) waiters.splice(n, 1);
      reject(new Error('Cancelled'));
    } };
    waiters.push(waiter); signal.addEventListener('abort', waiter.abort, { once: true });
  });
  try { signal.throwIfAborted(); return await task(); }
  finally {
    const next = waiters.shift();
    if (next) { next.signal.removeEventListener('abort', next.abort); next.resolve(); }
    else activeGpt--;
  }
}

export interface RoundRequest { stage: 'look' | 'motion'; feedback: string; count: Counts; director: Director; weight: number }
export async function runRound(store: Store, project: Project, request: RoundRequest, job: Job, emit: Emit, lora: LoraClient) {
  const { stage, feedback, count, director, weight } = request;
  const images = stageImages(project, stage).map(path => store.file(project.id, path));
  const context = directorPrompt(store.root, project, stage, feedback, count, images, lora.dir);
  emit(job, { type: 'status', text: 'ディレクターが候補を設計しています' });
  // One retry: a director that broke the format gets its own answer and the validation error back.
  let answer = await runAgent(job, emit, store.root, context.prompt, context.attachments, true);
  let result: ReturnType<typeof parseDirector>;
  try {
    result = parseDirector(answer, count, stage);
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error);
    emit(job, { type: 'status', text: `ディレクターの出力を直させています（${why}）` });
    answer = await runAgent(job, emit, store.root, `${context.prompt}\n\n--- your previous answer ---\n${answer.slice(0, 6000)}\n\nIt was rejected: ${why}. Return the corrected fenced json object only.`, context.attachments, true);
    result = parseDirector(answer, count, stage);
  }
  job.abort.signal.throwIfAborted();
  const p = store.get(project.id);
  const n = Math.max(0, ...p.rounds.map(r => r.n)) + 1;
  const round: Round = { n, stage, feedback, director: { ...director, notes: result.notes }, at: Date.now(), items: result.items.map((item, k) => ({ ...item, id: `${stage}-r${n}-${String(k + 1).padStart(2, '0')}`, file: null, status: 'queued', rating: 0, note: '' })) };
  p.rounds.push(round); p.stage = stage; store.save(p);
  for (const item of round.items) emit(job, { type: 'item', text: JSON.stringify(item) });
  const change = (id: string, patch: Partial<Item>) => {
    const p = store.get(project.id), item = store.item(p, id);
    Object.assign(item, patch); store.save(p);
    emit(job, { type: 'item', text: JSON.stringify(item) });
  };
  const generate = async (item: Item, k: number) => {
    try {
      job.abort.signal.throwIfAborted();
      change(item.id, { status: 'running' });
      const file = `${stage}/r${n}-${String(k + 1).padStart(2, '0')}.png`, target = store.file(project.id, file);
      mkdirSync(dirname(target), { recursive: true });
      const prompt = stage === 'motion' && item.motion ? `${item.prompt}\nThe motion to make visible: ${item.motion}` : item.prompt;
      if (item.engine === 'gpt-image') await generateGpt(job, store.root, prompt, target, images, stage === 'motion');
      else { await lora.start(job); await lora.generate(item.prompt, target, weight, job.abort.signal); }
      job.abort.signal.throwIfAborted();
      store.image(project.id, file);
      change(item.id, { file, status: 'done' });
    } catch (error) {
      change(item.id, { status: 'error', error: job.abort.signal.aborted ? 'Cancelled' : error instanceof Error ? error.message : String(error) });
      throw error;
    }
  };
  const results = await Promise.allSettled(round.items.map((item, k) => item.engine === 'gpt-image'
    ? gptSlot(job.abort.signal, () => generate(item, k)).catch(error => {
      if (store.item(store.get(project.id), item.id).status === 'queued') change(item.id, { status: 'error', error: 'Cancelled' });
      throw error;
    }) : generate(item, k)));
  const failed = results.filter(r => r.status === 'rejected');
  if (failed.length) throw new Error(`${failed.length}/${round.items.length} images failed; inspect item errors`);
  return `${stage} の候補 ${round.items.length} 枚を生成しました`;
}
