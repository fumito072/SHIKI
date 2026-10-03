// Agent jobs on the dev server's bridge (tools/agent-bridge): start, follow over SSE, cancel, and — for jobs that edit
// a work — compile the result in the live preview and hand errors back to the same agent (automatic repair).
export type AgentId = 'claude' | 'codex';

export interface ModelOption {
  id: string;
  label: string;
  efforts: string[];
}
export interface AgentOptions {
  claude: { models: ModelOption[]; default: { model: string; effort: string } };
  codex: { models: ModelOption[]; default: { model: string; effort: string } };
}
export interface AgentEvent {
  type: 'status' | 'text' | 'tool' | 'error' | 'done' | 'item';
  text: string;
  at: number;
}
export interface Pick {
  agent: AgentId;
  model: string;
  effort: string;
}
export interface Prefs {
  agent: AgentId;
  pick: Record<AgentId, { model: string; effort: string }>;
  attach: boolean;
  keyVisual: boolean;
  autoRepair: boolean;
}

const PREFS_KEY = 'shiki.studio';
export const MAX_REPAIRS = 2;

export function loadPrefs(): Prefs {
  const base: Prefs = {
    agent: 'claude',
    pick: { claude: { model: '', effort: '' }, codex: { model: '', effort: '' } },
    attach: true,
    keyVisual: false,
    autoRepair: true,
  };
  try {
    return { ...base, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Partial<Prefs> | null) };
  } catch {
    return base;
  }
}

export function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

let optionsCache: Promise<AgentOptions | null> | null = null;
export function agentOptions(): Promise<AgentOptions | null> {
  optionsCache ??= fetch('/__shiki/agent/options')
    .then((r) => (r.ok ? (r.json() as Promise<AgentOptions>) : null))
    .catch(() => null);
  return optionsCache;
}

/** Resolves a usable model/effort for an agent from saved prefs and the bridge's options. */
export function resolvePick(options: AgentOptions | null, prefs: Prefs, agent = prefs.agent): Pick {
  const o = options?.[agent];
  const want = prefs.pick[agent];
  const model = o?.models.find((m) => m.id === want.model) ?? o?.models.find((m) => m.id === o.default.model) ?? o?.models[0];
  const efforts = model?.efforts ?? [];
  const effort = efforts.includes(want.effort) ? want.effort : efforts.includes(o?.default.effort ?? '') ? o!.default.effort : efforts[0] ?? '';
  return { agent, model: model?.id ?? want.model, effort };
}

/** WebGL info logs end in NUL bytes. */
export const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();

export interface JobHandle {
  id: string;
  close(): void;
}

/**
 * Follows a job's event stream. The server replays the whole job on every (re)connect, so `reset` fires before the
 * replay and the caller starts its log from empty.
 */
export function follow(id: string, on: { reset?(): void; event(e: AgentEvent): void }): JobHandle {
  let finished = false;
  const es = new EventSource(`/__shiki/agent/events?job=${encodeURIComponent(id)}`);
  es.onopen = () => on.reset?.();
  es.onmessage = (m) => {
    const e = JSON.parse(m.data as string) as AgentEvent;
    if (e.type === 'done' || e.type === 'error') finished = true;
    on.event(e);
    if (finished) es.close();
  };
  es.onerror = () => {
    if (finished) es.close();
  };
  return { id, close: () => es.close() };
}

export async function cancel(id: string): Promise<void> {
  await fetch(`/__shiki/agent/cancel?job=${encodeURIComponent(id)}`, { method: 'POST' });
}

export async function postJson<T>(url: string, body: unknown): Promise<{ ok: boolean; status: number; data: T & { error?: string } }> {
  const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  let data = {} as T & { error?: string };
  try {
    data = (await res.json()) as T & { error?: string };
  } catch {
    /* empty body */
  }
  return { ok: res.ok, status: res.status, data };
}

export interface EditRun extends Pick {
  mode: 'feedback' | 'create';
  workId: string | null;
  message: string;
  snapshot?: string;
  keyVisual?: boolean;
  attempt?: number;
}

export interface EditCallbacks {
  /** A new turn (the request, or an automatic repair). */
  turn(run: EditRun, jobId: string): void;
  line(type: AgentEvent['type'], text: string): void;
  state(s: 'running' | 'verifying' | 'done' | 'error' | 'cancelled', run: EditRun): void;
  /** Compiles works/<id>/ in the preview; returns the error or null. */
  verify(id: string): Promise<string | null>;
  autoRepair(): boolean;
}

const repairMessage = (err: string) =>
  `自動修復：直前の変更のあと、プレビューで次のエラーが出て作品が動きません。見た目と振る舞いの意図は変えず、原因だけを直してください。\n\n${clean(err).slice(0, 3000)}`;

/** Starts an edit/create job and drives the verify → repair loop. Returns null, or an error message. */
export async function runEdit(run: EditRun, cb: EditCallbacks, setHandle: (h: JobHandle | null) => void): Promise<string | null> {
  const res = await postJson<{ job?: string }>('/__shiki/agent/run', { ...run, workId: run.workId ?? undefined });
  if (!res.ok || !res.data.job) return res.data.error ?? `送信できません (${res.status})`;
  const jobId = res.data.job;
  cb.turn(run, jobId);
  cb.state('running', run);
  setHandle(follow(jobId, { event: (e) => onEvent(run, e, cb, setHandle) }));
  return null;
}

/** Re-attaches to a job that was already running (e.g. after a page reload). */
export function resumeEdit(run: EditRun, jobId: string, cb: EditCallbacks, setHandle: (h: JobHandle | null) => void): void {
  cb.turn(run, jobId);
  cb.state('running', run);
  setHandle(follow(jobId, { event: (e) => onEvent(run, e, cb, setHandle) }));
}

function onEvent(run: EditRun, e: AgentEvent, cb: EditCallbacks, setHandle: (h: JobHandle | null) => void) {
  if (e.type === 'done') {
    const cancelled = !e.text.startsWith('{');
    let created: string | null = null;
    if (!cancelled) {
      try {
        created = (JSON.parse(e.text) as { createdWorkId?: string | null }).createdWorkId ?? null;
      } catch {
        /* plain text */
      }
    }
    setHandle(null);
    if (cancelled) {
      cb.line('done', '中止しました。');
      cb.state('cancelled', run);
    } else void check(run, created ?? run.workId, created !== null, cb, setHandle);
  } else if (e.type === 'error') {
    setHandle(null);
    cb.line('error', e.text);
    cb.state('error', run);
  } else cb.line(e.type, e.text);
}

async function check(run: EditRun, id: string | null, created: boolean, cb: EditCallbacks, setHandle: (h: JobHandle | null) => void) {
  if (!id) {
    cb.line('error', '新しい作品フォルダが見つかりません。');
    cb.state('error', run);
    return;
  }
  cb.state('verifying', run);
  cb.line('status', 'プレビューで検証中…');
  const err = await cb.verify(id);
  if (!err) {
    cb.line('done', created ? `完了 · ${id} を開きました` : '完了 · プレビューに反映しました');
    cb.state('done', run);
    return;
  }
  cb.line('error', `プレビューで動きません\n${clean(err).slice(0, 600)}`);
  const attempt = (run.attempt ?? 0) + 1;
  if (!cb.autoRepair() || attempt > MAX_REPAIRS) {
    cb.line('status', '自動修復を止めました。ひとつ前の版に戻すか、FB で指示してください。');
    cb.state('error', run);
    return;
  }
  const failed = await runEdit(
    { agent: run.agent, model: run.model, effort: run.effort, mode: 'feedback', workId: id, message: repairMessage(err), attempt },
    cb,
    setHandle,
  );
  if (failed) {
    cb.line('error', failed);
    cb.state('error', run);
  }
}
