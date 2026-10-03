// Studio panel: create works and give feedback from the control window. The dev server's agent bridge
// (tools/agent-bridge) runs the user's subscription Claude Code / Codex CLIs; edited works hot-reload on their own.
import { h } from './dom';

type AgentId = 'claude' | 'codex';
type Mode = 'feedback' | 'create';

interface ModelOption {
  id: string;
  label: string;
  efforts: string[];
}
interface Options {
  claude: { models: ModelOption[]; default: { model: string; effort: string } };
  codex: { models: ModelOption[]; default: { model: string; effort: string } };
}
interface AgentEvent {
  type: 'status' | 'text' | 'tool' | 'error' | 'done';
  text: string;
  at: number;
}
interface JobInfo {
  id: string;
  agent: AgentId;
  model: string;
  effort: string;
  mode: Mode;
  workId: string | null;
  message: string;
  state: string;
  started: number;
  /** Automatic repair round (0 = the user's own request). */
  attempt?: number;
}
interface RunParams {
  agent: AgentId;
  model: string;
  effort: string;
  mode: Mode;
  workId: string | null;
  message: string;
  snapshot?: string;
  keyVisual?: boolean;
  attempt?: number;
}
interface Version {
  version: string;
  message?: string;
  agent?: string;
  model?: string;
  effort?: string;
  at?: number;
  restore?: boolean;
  attempt?: number;
}

export interface StudioHost {
  /** Folder id and display name of the work on the selected deck (the default FB target). */
  current(): { id: string; name: string } | null;
  /** Every work folder, including ones that do not load right now (they can still get feedback or be restored). */
  works(): { id: string; name: string; broken: boolean }[];
  /** The preview frame as a JPEG data URL. */
  capture(): Promise<string>;
  /**
   * Puts works/<id>/ on the preview once the registry has its latest code (fail-safe load) and returns the
   * load/compile error, or null when it runs.
   */
  verify(id: string): Promise<string | null>;
}

interface Prefs {
  agent: AgentId;
  pick: Record<AgentId, { model: string; effort: string }>;
  attach: boolean;
  keyVisual: boolean;
  autoRepair: boolean;
}

const PREFS_KEY = 'shiki.studio';
const MAX_REPAIRS = 2;
const repairMessage = (err: string) =>
  `自動修復：直前の変更のあと、プレビューで次のエラーが出て作品が動きません。見た目と振る舞いの意図は変えず、原因だけを直してください。\n\n${clean(err).slice(0, 3000)}`;
/** WebGL info logs end in NUL bytes. */
const clean = (s: string) => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
const CHIPS = [
  '予測を裏切りきれていない',
  '動きが単調、緩急がほしい',
  'ドロップの解放が弱い',
  'ビルドの溜めが足りない',
  '情報量が多すぎる',
  '色が濁っている',
  'もっと静けさを',
  '境界が壊れていない',
];

function loadPrefs(): Prefs | null {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? 'null') as Prefs | null;
  } catch {
    return null;
  }
}

function savePrefs(p: Prefs): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  } catch {
    /* storage unavailable */
  }
}

const clockText = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

export function mountStudio(host: StudioHost): { el: HTMLElement; refresh(): void } {
  let options: Options | null = null;
  let mode: Mode = 'feedback';
  let job: JobInfo | null = null;
  let source: EventSource | null = null;
  let timer = 0;
  let out: HTMLElement = h('div');
  const prefs: Prefs = {
    agent: 'claude',
    pick: { claude: { model: '', effort: '' }, codex: { model: '', effort: '' } },
    attach: true,
    keyVisual: false,
    autoRepair: true,
    ...loadPrefs(),
  };

  // ---------- elements ----------
  const modeBtns = {
    feedback: h('button', { class: 'seg', type: 'button', onclick: () => setMode('feedback') }, 'この作品に FB'),
    create: h('button', { class: 'seg', type: 'button', onclick: () => setMode('create') }, '新しい作品'),
  };
  // FB target: follows the selected deck, unless the user picks another work (e.g. one that no longer loads).
  let picked: string | null = null;
  let lastCurrent: string | null = null;
  const targetSel = h('select', { 'aria-label': 'FB の対象', onchange: () => { picked = targetSel.value; render(); void loadHistory(); } });
  const createNote = h('div', { class: 'target' }, '新しいフォルダ works/<id>/ に作ります');
  const target = h('label', { class: 'tgt' }, h('span', { class: 'lbl' }, '対象'), targetSel);
  const targetId = (): string | null => picked ?? host.current()?.id ?? null;
  const agentBtns = {
    claude: h('button', { class: 'seg', type: 'button', onclick: () => setAgent('claude') }, 'Claude'),
    codex: h('button', { class: 'seg', type: 'button', onclick: () => setAgent('codex') }, 'Codex'),
  };
  const modelSel = h('select', { 'aria-label': 'モデル', onchange: () => pick() });
  const effortSel = h('select', { 'aria-label': 'エフォート', onchange: () => pick() });
  const input = h('textarea', {
    rows: 4,
    onkeydown: (e: KeyboardEvent) => {
      e.stopPropagation(); // performance keys must not fire while typing
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void run();
    },
    onkeyup: (e: KeyboardEvent) => e.stopPropagation(),
  });
  const chips = h('div', { class: 'chips' },
    ...CHIPS.map((c) => h('button', { class: 'chip', type: 'button', onclick: () => addChip(c) }, c)),
  );
  const attach = h('input', { type: 'checkbox', checked: prefs.attach, onchange: () => { prefs.attach = attach.checked; savePrefs(prefs); } });
  const keyVisual = h('input', { type: 'checkbox', checked: prefs.keyVisual, onchange: () => { prefs.keyVisual = keyVisual.checked; savePrefs(prefs); } });
  const keyVisualRow = h('label', { class: 'check' }, keyVisual, h('span', {}, 'キービジュアル（画像）から始める'));
  const autoRepair = h('input', { type: 'checkbox', checked: prefs.autoRepair, onchange: () => { prefs.autoRepair = autoRepair.checked; savePrefs(prefs); } });
  const sendBtn = h('button', { class: 'btn on wide', type: 'button', onclick: () => void run() }, '送信  ⌘⏎');
  const cancelBtn = h('button', { class: 'btn', type: 'button', onclick: () => void cancel() }, '中止');
  const status = h('div', { class: 'status' });
  const log = h('div', { class: 'log', 'aria-live': 'polite' });
  const history = h('div', { class: 'history' });

  const el = h('div', { class: 'studio' },
    h('section', { class: 'box' },
      h('div', { class: 'segs' }, modeBtns.feedback, modeBtns.create),
      target,
      createNote,
      h('div', { class: 'segs' }, agentBtns.claude, agentBtns.codex),
      h('div', { class: 'pick' },
        h('label', {}, h('span', { class: 'lbl' }, 'Model'), modelSel),
        h('label', {}, h('span', { class: 'lbl' }, 'Effort'), effortSel),
      ),
      input,
      chips,
      h('label', { class: 'check' }, attach, h('span', {}, '今の画面を添付')),
      keyVisualRow,
      h('label', { class: 'check' }, autoRepair, h('span', {}, '動かなければ自動で直させる')),
      h('div', { class: 'row' }, sendBtn, cancelBtn),
      status,
    ),
    h('section', { class: 'box' }, h('span', { class: 'lbl' }, 'Agent log'), log),
    h('section', { class: 'box' }, h('span', { class: 'lbl' }, 'Versions'), history),
  );

  // ---------- selection ----------
  function setMode(m: Mode) {
    mode = m;
    render();
  }

  function setAgent(a: AgentId) {
    prefs.agent = a;
    savePrefs(prefs);
    fillPickers();
    render();
  }

  function fillPickers() {
    const o = options?.[prefs.agent];
    if (!o) return;
    const want = prefs.pick[prefs.agent];
    const model = o.models.find((m) => m.id === want.model) ?? o.models.find((m) => m.id === o.default.model) ?? o.models[0];
    modelSel.replaceChildren(...o.models.map((m) => h('option', { value: m.id, selected: m.id === model?.id }, m.label)));
    const efforts = model?.efforts ?? [];
    const effort = efforts.includes(want.effort) ? want.effort : efforts.includes(o.default.effort) ? o.default.effort : efforts[0];
    effortSel.replaceChildren(...efforts.map((e) => h('option', { value: e, selected: e === effort }, e)));
    prefs.pick[prefs.agent] = { model: model?.id ?? '', effort: effort ?? '' };
  }

  function pick() {
    prefs.pick[prefs.agent] = { model: modelSel.value, effort: effortSel.value };
    fillPickers(); // the effort list depends on the model
    savePrefs(prefs);
  }

  function addChip(text: string) {
    input.value = input.value.trim() ? `${input.value.trim()}\n${text}` : text;
    input.focus();
  }

  function fillTargets() {
    const cur = host.current();
    if ((cur?.id ?? null) !== lastCurrent) {
      lastCurrent = cur?.id ?? null;
      picked = null;
    }
    const id = targetId();
    targetSel.replaceChildren(
      ...host.works().map((w) =>
        h('option', { value: w.id, selected: w.id === id },
          `${w.id === cur?.id ? cur.name : w.name}${w.broken ? '  ⚠ 動いていない' : ''}`)),
    );
  }

  function render() {
    const tid = targetId();
    const running = job?.state === 'running';
    modeBtns.feedback.classList.toggle('on', mode === 'feedback');
    modeBtns.create.classList.toggle('on', mode === 'create');
    agentBtns.claude.classList.toggle('on', prefs.agent === 'claude');
    agentBtns.codex.classList.toggle('on', prefs.agent === 'codex');
    target.hidden = mode !== 'feedback';
    createNote.hidden = mode !== 'create';
    input.placeholder = mode === 'feedback'
      ? 'あーじゃない、こーじゃない。見て感じたことをそのまま。'
      : 'どんな作品？ 情景、音との関係、壊したい境界、裏切りたい予測。';
    chips.hidden = mode !== 'feedback';
    keyVisualRow.hidden = mode !== 'create' || prefs.agent !== 'codex';
    sendBtn.disabled = running || !options || (mode === 'feedback' && !tid);
    cancelBtn.disabled = !running;
  }

  // ---------- jobs ----------
  async function run() {
    const tid = targetId();
    const message = input.value.trim();
    if (!message || job?.state === 'running' || (mode === 'feedback' && !tid)) return;
    const { model, effort } = prefs.pick[prefs.agent];
    const ok = await start({
      agent: prefs.agent, model, effort, mode, message,
      workId: mode === 'feedback' ? tid : null,
      snapshot: prefs.attach ? await host.capture() : undefined,
      keyVisual: mode === 'create' && prefs.agent === 'codex' && prefs.keyVisual,
    });
    if (ok) input.value = '';
  }

  async function start(p: RunParams): Promise<boolean> {
    const res = await fetch('/__shiki/agent/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...p, workId: p.workId ?? undefined }),
    });
    const body = (await res.json()) as { job?: string; error?: string };
    if (!res.ok || !body.job) {
      status.textContent = body.error ?? `送信できません (${res.status})`;
      status.className = 'status err';
      return false;
    }
    follow({ ...p, id: body.job, state: 'running', started: Date.now() });
    return true;
  }

  function follow(info: JobInfo) {
    job = info;
    source?.close();
    // One block per job: the request, then the agent's events. The server replays the whole job on every
    // (re)connect, so the block's events start from empty each time.
    const head = info.attempt
      ? h('div', { class: 'ev you repair' }, `自動修復 ${info.attempt}/${MAX_REPAIRS}`)
      : h('div', { class: 'ev you' }, info.message);
    const events = h('div', { class: 'events' });
    log.append(h('div', { class: 'turn' }, head, events));
    while (log.childElementCount > 12) log.firstElementChild?.remove();
    out = events;
    const es = new EventSource(`/__shiki/agent/events?job=${encodeURIComponent(info.id)}`);
    source = es;
    es.onopen = () => events.replaceChildren();
    es.onmessage = (m) => onEvent(info, JSON.parse(m.data as string) as AgentEvent);
    es.onerror = () => {
      if (info.state !== 'running') es.close();
    };
    clearInterval(timer);
    timer = window.setInterval(tick, 1000);
    tick();
    render();
  }

  function onEvent(info: JobInfo, e: AgentEvent) {
    if (e.type === 'done') {
      const wasCancel = info.state === 'cancelled' || !e.text.startsWith('{');
      let created: string | null = null;
      if (!wasCancel) {
        try {
          created = (JSON.parse(e.text) as { createdWorkId?: string | null }).createdWorkId ?? null;
        } catch {
          /* plain text */
        }
      }
      info.state = wasCancel ? 'cancelled' : 'done';
      finish();
      if (wasCancel) line('done', '中止しました。');
      else void check(info, created ?? info.workId, created !== null);
    } else if (e.type === 'error') {
      info.state = 'error';
      line('error', e.text);
      finish();
    } else {
      line(e.type, e.text);
    }
  }

  /** Compiles the finished work in the preview; on failure hands the error back to the same agent. */
  async function check(info: JobInfo, id: string | null, created: boolean) {
    if (!id) {
      line('error', '新しい作品フォルダが見つかりません。');
      return;
    }
    line('status', 'プレビューで検証中…');
    const err = await host.verify(id);
    void loadHistory();
    if (!err) {
      line('done', created ? `完了 · 新作 ${id} を開きました` : '完了 · プレビューに反映しました');
      return;
    }
    line('error', `プレビューで動きません\n${clean(err).slice(0, 600)}`);
    const attempt = (info.attempt ?? 0) + 1;
    if (!prefs.autoRepair || attempt > MAX_REPAIRS) {
      line('status', '自動修復を止めました。ひとつ前の版に戻すか、FB で指示してください。');
      return;
    }
    await start({ agent: info.agent, model: info.model, effort: info.effort, mode: 'feedback', workId: id, message: repairMessage(err), attempt });
  }

  function line(type: AgentEvent['type'], text: string) {
    out.append(h('div', { class: `ev ${type}` }, type === 'tool' ? `› ${text}` : text));
    log.scrollTop = log.scrollHeight;
  }

  function finish() {
    source?.close();
    source = null;
    clearInterval(timer);
    tick();
    render();
    void loadHistory();
  }

  function tick() {
    if (!job) {
      status.textContent = '';
      return;
    }
    const label = { running: '作業中', done: '完了', error: 'エラー', cancelled: '中止' }[job.state] ?? job.state;
    status.className = `status ${job.state === 'running' ? 'run' : job.state === 'error' ? 'err' : ''}`;
    status.textContent = `${label} · ${clockText(Date.now() - job.started)} · ${job.agent} ${job.model} ${job.effort}`;
  }

  async function cancel() {
    if (!job || job.state !== 'running') return;
    job.state = 'cancelled';
    await fetch(`/__shiki/agent/cancel?job=${encodeURIComponent(job.id)}`, { method: 'POST' });
    render();
  }

  // ---------- versions ----------
  async function loadHistory() {
    const work = targetId();
    if (!work) return void history.replaceChildren();
    const list = (await (await fetch(`/__shiki/history?work=${encodeURIComponent(work)}`)).json()) as Version[];
    if (!list.length) {
      history.replaceChildren(h('p', { class: 'note' }, 'FB を送ると、その直前の状態がここに残ります。'));
      return;
    }
    history.replaceChildren(
      ...list.map((v) => {
        const btn = h('button', { class: 'btn', type: 'button' }, '戻す');
        let armed = false;
        btn.addEventListener('click', async () => {
          if (!armed) {
            armed = true;
            btn.textContent = '本当に？';
            btn.classList.add('live');
            setTimeout(() => {
              armed = false;
              btn.textContent = '戻す';
              btn.classList.remove('live');
            }, 3000);
            return;
          }
          await fetch('/__shiki/history/restore', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ work, version: v.version }),
          });
          void loadHistory();
        });
        const when = v.at ? new Date(v.at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : v.version;
        return h('div', { class: 'ver' },
          h('div', {},
            h('div', { class: 'mono meta' }, `${when}${v.agent ? ` · ${v.agent} ${v.model ?? ''} ${v.effort ?? ''}` : ''}`),
            h('div', { class: 'msg' }, v.restore ? '↩ 版を戻す直前の状態' : v.attempt ? `自動修復 ${v.attempt} の前` : `「${(v.message ?? '').slice(0, 80)}」の前`),
          ),
          btn,
        );
      }),
    );
  }

  // ---------- start ----------
  void (async () => {
    try {
      options = (await (await fetch('/__shiki/agent/options')).json()) as Options;
    } catch {
      status.textContent = 'エージェントブリッジに接続できません（npm run dev で起動してください）';
      status.className = 'status err';
    }
    fillPickers();
    render();
    try {
      const jobs = (await (await fetch('/__shiki/agent/jobs')).json()) as JobInfo[];
      const live = jobs.find((j) => j.state === 'running');
      if (live) follow(live);
    } catch {
      /* no bridge */
    }
  })();
  fillTargets();
  void loadHistory();
  render();

  return {
    el,
    refresh() {
      fillTargets();
      render();
      void loadHistory();
    },
  };
}
