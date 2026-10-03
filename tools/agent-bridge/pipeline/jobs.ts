import type { ChildProcess } from 'node:child_process';
import { spawnAgent, toEvents } from './agents';
import type { AgentEvent, Director, Job } from './types';

export type Emit = (job: Job, event: Omit<AgentEvent, 'at'>) => void;

export function killChild(proc: ChildProcess) {
  try { if (proc.pid) process.kill(-proc.pid, 'SIGTERM'); else proc.kill('SIGTERM'); }
  catch { proc.kill('SIGTERM'); }
  const timer = setTimeout(() => {
    try { if (proc.pid) process.kill(-proc.pid, 'SIGKILL'); } catch { /* Process group already exited. */ }
  }, 2000);
  timer.unref();
}

export function cancelJob(job: Job) {
  job.state = 'cancelled';
  job.abort.abort();
  for (const proc of job.procs) killChild(proc);
}

export function finishJob(job: Job, emit: Emit, error?: unknown, summary = '') {
  if (job.state === 'cancelled') emit(job, { type: 'done', text: '中止しました' });
  else if (error) {
    job.state = 'error';
    emit(job, { type: 'error', text: error instanceof Error ? error.message : String(error) });
  } else {
    job.state = 'done';
    emit(job, { type: 'done', text: JSON.stringify({ summary, createdWorkId: job.createdWorkId ?? null }) });
  }
  job.finished = Date.now();
  for (const res of job.listeners) res.end();
  job.listeners.clear();
}

export function runAgent(job: Job, emit: Emit, root: string, text: string, images: string[] = [], readOnly = false, director: Director = job): Promise<string> {
  return new Promise((resolve, reject) => {
    if (job.abort.signal.aborted) return reject(new Error('Cancelled'));
    const proc = spawnAgent(director, text, root, images, readOnly);
    job.procs.add(proc);
    let buffer = '', final = '', tail = '', failure = '';
    const line = (value: string) => {
      try {
        const data = JSON.parse(value) as Record<string, unknown>;
        for (const event of toEvents(director.agent, data)) {
          if (event.type === 'text') final = event.text;
          if (event.type === 'error') failure = event.text;
          emit(job, event);
        }
        if (director.agent === 'claude' && data.type === 'result' && typeof data.result === 'string' && !data.is_error) final = data.result;
      } catch { /* Ignore CLI noise. */ }
    };
    proc.stdout?.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let n: number;
      while ((n = buffer.indexOf('\n')) >= 0) { line(buffer.slice(0, n)); buffer = buffer.slice(n + 1); }
    });
    proc.stderr?.on('data', (chunk: Buffer) => { tail = (tail + chunk.toString()).slice(-2000); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      job.procs.delete(proc);
      if (buffer.trim()) line(buffer);
      if (job.abort.signal.aborted) reject(new Error('Cancelled'));
      else if (code !== 0 || failure) reject(new Error(failure || `exit ${code}\n${tail.trim().split('\n').slice(-6).join('\n')}`));
      else resolve(final);
    });
  });
}
