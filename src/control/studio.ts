// Studio screen — image first (canvas "StudioImm"). 01 brief + references → 02 key-visual rounds with feedback →
// 03 about ten motion studies for the chosen image → 04 build the instrument from them → 05 perform.
// The art director (Claude or Codex, the user's subscriptions) writes the prompts; GPT Image (via Codex) and the user's
// Pinterest LoRA draw them (tools/agent-bridge/pipeline). A second tab keeps direct code feedback on existing works.
import { h } from './dom';
import {
  MAX_REPAIRS, agentOptions, cancel, follow, loadPrefs, postJson, resolvePick, resumeEdit, runEdit, savePrefs,
} from './jobs';
import type { AgentEvent, AgentId, AgentOptions, EditCallbacks, EditRun, JobHandle, Prefs } from './jobs';

type Stage = 'look' | 'motion' | 'build' | 'done';
type Engine = 'gpt-image' | 'pinterest-lora';
interface Item {
  id: string; file: string | null; engine: Engine; prompt: string; title: string;
  motion?: string; status: 'queued' | 'running' | 'done' | 'error'; error?: string;
  rating: -1 | 0 | 1; note: string;
}
interface Round {
  n: number; stage: 'look' | 'motion'; feedback: string;
  director: { agent: AgentId; model: string; effort: string; notes: string }; items: Item[]; at: number;
}
interface Project {
  id: string; title: string; brief: string; refs: string[]; stage: Stage; rounds: Round[];
  keyVisual: string | null; studies: string[]; workId: string | null; created: number; updated: number;
}
interface ProjectSummary { id: string; title: string; stage: Stage; updated: number; cover?: string | null }
interface LoraStatus { installed: boolean; running: boolean; phase?: string; loaded?: string | null; message?: string }
interface JobRow {
  id: string; state: string; projectId?: string; kind?: string; agent: AgentId; model: string; effort: string;
  mode: 'feedback' | 'create'; workId: string | null; message: string; started: number;
}
interface LikeEntry {
  project: string; projectTitle: string; item: string; title: string; stage: 'look' | 'motion';
  engine: Engine; prompt: string; motion?: string; note: string; likedAt: number; file: string;
}
interface Version { version: string; message?: string; agent?: string; model?: string; effort?: string; at?: number; restore?: boolean; attempt?: number }

export interface StudioHost {
  works(): { id: string; name: string; broken: boolean }[];
  current(): { id: string; name: string } | null;
  capture(): Promise<string>;
  verify(id: string): Promise<string | null>;
  setBackground(url: string | null): void;
  openPerform(): void;
}

const API = '/__shiki/studio';
const CHIPS_LOOK = ['もっと大胆に', '静けさがほしい', '素材感を強く', '構図を変えて', 'スケールを曖昧に', '色を一点だけ', 'Pinterest 寄りに', '予測を裏切って'];
const CHIPS_MOTION = ['溜めが長いほうがいい', '動きが予想どおり', 'ドロップで世界が裏返る', 'もっと静かな動き', '境界を壊して', '時間がずれる感じ'];
const CHIPS_FIX = ['予測を裏切りきれていない', '動きが単調、緩急がほしい', 'ドロップの解放が弱い', 'ビルドの溜めが足りない', '情報量が多すぎる', '色が濁っている'];
const STEPS = ['01 Brief', '02 Key visual', '03 Motion', '04 Build', '05 Perform'];

const fileUrl = (id: string, path: string) => `${API}/file?id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`;
const clock = (ms: number) => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};
const stopKeys = (el: HTMLElement) => {
  el.addEventListener('keydown', (e) => e.stopPropagation());
  el.addEventListener('keyup', (e) => e.stopPropagation());
};

/** Reads an image file as a JPEG data URL no larger than 2048 px (keeps uploads small). */
async function readImage(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((ok, fail) => {
      const i = new Image();
      i.onload = () => ok(i);
      i.onerror = fail;
      i.src = url;
    });
    const k = Math.min(1, 2048 / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.round(img.naturalWidth * k);
    c.height = Math.round(img.naturalHeight * k);
    c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.9);
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const r = await fetch(url);
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

export function mountStudio(host: StudioHost) {
  const prefs: Prefs = loadPrefs();
  let options: AgentOptions | null = null;
  let projects: ProjectSummary[] = [];
  let project: Project | null = null;
  let view: 'look' | 'motion' = 'look';
  let roundIx = -1; // which round of the current view is shown (-1 = latest)
  let selected: string | null = null; // look item picked as the key visual
  let job: { handle: JobHandle; started: number; label: string } | null = null;
  let tab: 'make' | 'fix' = 'make';
  let lora: LoraStatus | null = null;
  let pendingRefs: string[] = [];
  let holeKey = '';
  /** The ♥ library across all projects (library/likes, kept even if a project is deleted). */
  let likesOpen = false;
  let likes: LikeEntry[] = [];
  let likesDir = '';
  const counts = { gpt: 4, lora: 2, motion: 10, weight: 0.75 };

  // ======================================================================================== steps + PGM monitor
  const stepEls = STEPS.map((s) => h('span', { class: 's' }, h('i', { class: 'pip' }), s));
  const projSel = h('select', { class: 'sel', 'aria-label': '制作', onchange: () => void openProject(projSel.value || null) });
  const newBtn = h('button', { type: 'button', class: 'btn', onclick: () => void openProject(null) }, '+ 新しい制作');
  const pgm = h('div', { class: 'screen hole scan pgm air-out' });
  const pgmLabel = h('span', { class: 'lbl pgml' });
  const top = h('section', { class: 'glass stop holed' },
    h('ol', { class: 'steps' }, ...stepEls.flatMap((el, i) => (i ? [h('li', { class: 'wire', 'aria-hidden': 'true' }), h('li', {}, el)] : [h('li', {}, el)]))),
    h('div', { class: 'projpick' }, projSel, newBtn),
    h('div', { class: 'pgmbox', title: 'クリックで Perform へ', onclick: () => host.openPerform() }, pgm, h('span', { class: 'stack2', style: 'gap:2px' }, h('span', { class: 'onair' }, 'ON AIR'), pgmLabel)),
  );

  // ======================================================================================== left: the project
  const titleIn = h('input', { type: 'text', class: 'tin', placeholder: '題名（例：霧の中の脈動）', 'aria-label': '題名' });
  const slugIn = h('input', { type: 'text', class: 'tin slug', placeholder: '作品ID（英数字・任意）例 kiri-myakudo', 'aria-label': '作品ID', pattern: '[a-z0-9][a-z0-9-]*' });
  const briefIn = h('textarea', { class: 'brief', rows: 6, placeholder: 'どんな作品？ 情景、素材、光、音との関係、壊したい境界、裏切りたい予測。参考画像は下へ。' });
  const refsEl = h('div', { class: 'refs' });
  const refInput = h('input', { type: 'file', accept: 'image/*', multiple: true, style: 'display:none', onchange: () => void addRefs([...(refInput.files ?? [])]) });
  const drop = h('div', { class: 'drop', tabindex: 0, role: 'button', onclick: () => refInput.click() }, '参考画像をドロップ / クリック / ペースト');
  const startBtn = h('button', { type: 'button', class: 'btn prime', onclick: () => void startProject() }, '画像をつくる');
  const kvBox = h('div', { class: 'kvbox' });
  const left = h('section', { class: 'glass sleft' },
    h('div', { class: 'gh' }, h('span', { class: 't' }, h('span', { class: 'lbl', style: 'color:#ece6da' }, 'Brief'), h('span', { class: 'jp' }, 'ブリーフ'))),
    titleIn, slugIn, briefIn,
    h('div', { class: 'gh' }, h('span', { class: 't' }, h('span', { class: 'lbl', style: 'color:#ece6da' }, 'References'), h('span', { class: 'jp' }, '参考画像'))),
    refsEl, drop, refInput,
    startBtn,
    kvBox,
  );
  stopKeys(slugIn);
  for (const el of [titleIn, briefIn]) {
    stopKeys(el);
    el.addEventListener('change', () => void saveMeta());
  }
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    void addRefs([...(e.dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/')));
  });

  // ======================================================================================== center: the gallery
  const viewBtns = {
    look: h('button', { type: 'button', onclick: () => { likesOpen = false; view = 'look'; roundIx = -1; render(); } }, 'Key visual'),
    motion: h('button', { type: 'button', onclick: () => { likesOpen = false; view = 'motion'; roundIx = -1; render(); } }, 'Motion'),
    likes: h('button', { type: 'button', title: 'すべての制作の ♥（library/likes に保存）', onclick: () => { likesOpen = true; void loadLikes(); } }, '♥ Likes'),
  };
  const roundsNav = h('div', { class: 'rounds' });
  const notesEl = h('div', { class: 'dnotes jp2' });
  const grid = h('div', { class: 'gallery' });
  const empty = h('div', { class: 'empty jp2' });
  const center = h('section', { class: 'glass scenter' },
    h('div', { class: 'ph' }, h('div', { class: 'pq', role: 'tablist' }, viewBtns.look, viewBtns.motion, viewBtns.likes), roundsNav),
    notesEl,
    h('div', { class: 'gscroll' }, grid, empty),
  );

  // ======================================================================================== right: director, FB, fix
  const tabBtns = {
    make: h('button', { type: 'button', onclick: () => { tab = 'make'; render(); } }, '制作'),
    fix: h('button', { type: 'button', onclick: () => { tab = 'fix'; render(); void loadVersions(); } }, '作品を直す'),
  };
  const agentBtns = {
    claude: h('button', { type: 'button', onclick: () => setAgent('claude') }, 'Claude'),
    codex: h('button', { type: 'button', onclick: () => setAgent('codex') }, 'Codex'),
  };
  const modelSel = h('select', { class: 'sel', 'aria-label': 'モデル', onchange: () => pick() });
  const effortSel = h('select', { class: 'sel', 'aria-label': 'エフォート', onchange: () => pick() });
  const picker = h('div', { class: 'picker' },
    h('div', { class: 'pq' }, agentBtns.claude, agentBtns.codex),
    h('div', { class: 'pk2' },
      h('label', { class: 'stack2', style: 'gap:3px' }, h('span', { class: 'lbl' }, 'Model'), modelSel),
      h('label', { class: 'stack2', style: 'gap:3px' }, h('span', { class: 'lbl' }, 'Effort'), effortSel)),
  );

  const stepper = (label: string, get: () => number, set: (n: number) => void, max = 12) => {
    const v = h('span', { class: 'num sv' });
    const paint = () => (v.textContent = String(get()));
    paint();
    return h('div', { class: 'stp' },
      h('span', { class: 'lbl' }, label),
      h('button', { type: 'button', class: 'btn', 'aria-label': `${label}を減らす`, onclick: () => { set(Math.max(0, get() - 1)); paint(); } }, '−'),
      v,
      h('button', { type: 'button', class: 'btn', 'aria-label': `${label}を増やす`, onclick: () => { set(Math.min(max, get() + 1)); paint(); } }, '+'),
    );
  };
  const loraLine = h('span', { class: 'mono lora-st' });
  const loraStart = h('button', { type: 'button', class: 'btn', onclick: () => void startLora() }, '起動');
  const weightVal = h('span', { class: 'mono', style: 'font-size:10px' }, counts.weight.toFixed(2));
  const weightIn = h('input', {
    type: 'range', class: 'rng', min: 0.3, max: 1.1, step: 0.05, value: counts.weight, 'aria-label': 'Pinterest LoRA の強さ',
    oninput: () => { counts.weight = Number(weightIn.value); weightVal.textContent = counts.weight.toFixed(2); },
  });
  const engines = h('div', { class: 'engines' },
    stepper('GPT Image', () => counts.gpt, (n) => (counts.gpt = n)),
    stepper('Pinterest LoRA', () => counts.lora, (n) => (counts.lora = n)),
    h('div', { class: 'wrow' }, h('span', { class: 'lbl' }, 'LoRA 強さ'), weightIn, weightVal),
    h('div', { class: 'wrow' }, loraLine, loraStart),
  );
  const motionCount = stepper('動きの案', () => counts.motion, (n) => (counts.motion = Math.max(1, n)));

  const fbIn = h('textarea', { class: 'fb', rows: 4 });
  stopKeys(fbIn);
  fbIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void nextRound();
  });
  const chips = h('div', { class: 'chips' });
  const roundBtn = h('button', { type: 'button', class: 'btn prime', onclick: () => void nextRound() });
  const advanceBtn = h('button', { type: 'button', class: 'btn live adv', onclick: () => void advance() });
  const cancelBtn = h('button', { type: 'button', class: 'btn', onclick: () => void stopJob() }, '中止');
  const statusEl = h('div', { class: 'mono jstatus' });
  const logEl = h('div', { class: 'jlog' });
  const make = h('div', { class: 'make' },
    h('div', { class: 'gh' }, h('span', { class: 't' }, h('span', { class: 'lbl', style: 'color:#ece6da' }, 'Art director'), h('span', { class: 'jp' }, 'アートディレクター'))),
    picker,
    engines,
    motionCount,
    h('div', { class: 'gh' }, h('span', { class: 't' }, h('span', { class: 'lbl', style: 'color:#ece6da' }, 'Feedback'), h('span', { class: 'jp' }, 'あーじゃない、こーじゃない'))),
    fbIn, chips,
    h('div', { class: 'acts' }, roundBtn, cancelBtn),
    advanceBtn,
    statusEl,
    logEl,
  );

  // ---- fix tab: direct feedback on an existing work (code), with versions
  const fixTarget = h('select', { class: 'sel', 'aria-label': 'FB の対象' });
  const fixIn = h('textarea', { class: 'fb', rows: 4, placeholder: 'あーじゃない、こーじゃない。見て感じたことをそのまま。' });
  stopKeys(fixIn);
  fixIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) void sendFix();
  });
  const fixChips = h('div', { class: 'chips' }, ...CHIPS_FIX.map((c) => h('button', { type: 'button', class: 'chip', onclick: () => addTo(fixIn, c) }, c)));
  const attach = h('input', { type: 'checkbox', class: 'cb', checked: prefs.attach, onchange: () => { prefs.attach = attach.checked; savePrefs(prefs); } });
  const autoRepair = h('input', { type: 'checkbox', class: 'cb', checked: prefs.autoRepair, onchange: () => { prefs.autoRepair = autoRepair.checked; savePrefs(prefs); } });
  const fixSend = h('button', { type: 'button', class: 'btn prime', onclick: () => void sendFix() }, '送信 ⌘⏎');
  const versions = h('div', { class: 'versions' });
  let fixPicked: string | null = null;
  let fixSeen: string | null = null;
  fixTarget.addEventListener('change', () => { fixPicked = fixTarget.value; void loadVersions(); });
  const fixPickerSlot = h('div');
  const fix = h('div', { class: 'fix' },
    fixPickerSlot,
    h('label', { class: 'stack2', style: 'gap:4px' }, h('span', { class: 'lbl' }, '対象の作品'), fixTarget),
    fixIn, fixChips,
    h('label', { class: 'chk' }, attach, h('span', {}, '今の画面を添付')),
    h('label', { class: 'chk' }, autoRepair, h('span', {}, `動かなければ自動で直させる（最大 ${MAX_REPAIRS} 回）`)),
    h('div', { class: 'acts' }, fixSend),
    h('div', { class: 'gh' }, h('span', { class: 't' }, h('span', { class: 'lbl', style: 'color:#ece6da' }, 'Versions'), h('span', { class: 'jp' }, 'FB 前の版'))),
    versions,
  );

  const right = h('section', { class: 'glass sright' }, h('div', { class: 'pq tabs2' }, tabBtns.make, tabBtns.fix), make, fix);
  const zoomEl = h('div', { class: 'zoombox', hidden: true, onclick: () => (zoomEl.hidden = true) });
  const el = h('div', { class: 'ui studio' }, top, left, center, right, zoomEl);

  // ======================================================================================== agent picker
  function fillPicker() {
    const o = options?.[prefs.agent];
    if (!o) return;
    const p = resolvePick(options, prefs);
    modelSel.replaceChildren(...o.models.map((m) => h('option', { value: m.id, selected: m.id === p.model }, m.label)));
    const efforts = o.models.find((m) => m.id === p.model)?.efforts ?? [];
    effortSel.replaceChildren(...efforts.map((e) => h('option', { value: e, selected: e === p.effort }, e)));
    prefs.pick[prefs.agent] = { model: p.model, effort: p.effort };
  }
  function pick() {
    prefs.pick[prefs.agent] = { model: modelSel.value, effort: effortSel.value };
    fillPicker();
    savePrefs(prefs);
  }
  function setAgent(a: AgentId) {
    prefs.agent = a;
    savePrefs(prefs);
    fillPicker();
    render();
  }
  function addTo(target: HTMLTextAreaElement, text: string) {
    target.value = target.value.trim() ? `${target.value.trim()}\n${text}` : text;
    target.focus();
  }
  const pickNow = () => resolvePick(options, prefs);

  // ======================================================================================== data
  async function loadProjects() {
    projects = (await getJson<ProjectSummary[]>(`${API}/projects`)) ?? [];
    projSel.replaceChildren(
      h('option', { value: '' }, projects.length ? '— 制作を選ぶ —' : '— まだ制作がありません —'),
      ...projects.map((p) => h('option', { value: p.id, selected: p.id === project?.id }, `${p.title} · ${p.stage}`)),
    );
  }

  async function openProject(id: string | null) {
    project = id ? await getJson<Project>(`${API}/project?id=${encodeURIComponent(id)}`) : null;
    pendingRefs = [];
    selected = null;
    titleIn.value = project?.title ?? '';
    briefIn.value = project?.brief ?? '';
    view = project && project.stage !== 'look' ? 'motion' : 'look';
    roundIx = -1;
    try {
      if (project) localStorage.setItem('shiki.studio.project', project.id);
      else localStorage.removeItem('shiki.studio.project');
    } catch {
      /* storage unavailable */
    }
    projSel.value = project?.id ?? '';
    render();
  }

  async function reload() {
    if (!project) return;
    const p = await getJson<Project>(`${API}/project?id=${encodeURIComponent(project.id)}`);
    if (p) project = p;
    render();
  }

  async function addRefs(files: File[]) {
    if (!files.length) return;
    const urls = await Promise.all(files.slice(0, 8).map(readImage));
    if (project) {
      const r = await postJson<Project>(`${API}/project/refs`, { id: project.id, refs: urls });
      if (!r.ok) return status(r.data.error ?? '参考画像を追加できません', 'err');
      project = r.data;
    } else pendingRefs.push(...urls);
    render();
  }

  async function removeRef(path: string) {
    if (!project) return;
    const r = await postJson<Project>(`${API}/project/refs/remove`, { id: project.id, path });
    if (r.ok) project = r.data;
    render();
  }

  async function saveMeta() {
    if (!project) return;
    const r = await postJson<Project>(`${API}/project/update`, { id: project.id, title: titleIn.value.trim() || project.title, brief: briefIn.value });
    if (r.ok) project = r.data;
  }

  // ======================================================================================== actions
  const director = () => {
    const p = pickNow();
    return { agent: p.agent, model: p.model, effort: p.effort };
  };

  async function startProject() {
    const title = titleIn.value.trim();
    const brief = briefIn.value.trim();
    if (!title || !brief) return status('題名とブリーフを書いてください', 'err');
    const r = await postJson<Project>(`${API}/projects`, { title, brief, refs: pendingRefs, slug: slugIn.value.trim() || undefined });
    if (!r.ok) return status(r.data.error ?? `作れません (${r.status})`, 'err');
    pendingRefs = [];
    await loadProjects();
    await openProject(r.data.id);
    await nextRound();
  }

  /** Generates a round for the current view (look or motion) from the feedback and the likes. */
  async function nextRound() {
    if (!project || job) return;
    const stage = view;
    if (stage === 'motion' && !project.keyVisual) return status('先にキービジュアルを決めてください', 'err');
    const count = stage === 'look' ? { gpt: counts.gpt, lora: counts.lora } : { gpt: counts.motion, lora: 0 };
    if (count.gpt + count.lora < 1) return status('枚数が 0 です', 'err');
    const r = await postJson<{ job?: string }>(`${API}/project/round`, {
      id: project.id, stage, feedback: fbIn.value.trim(), count, director: director(), lora: { weight: counts.weight },
    });
    if (!r.ok || !r.data.job) return status(r.data.error ?? `始められません (${r.status})`, 'err');
    fbIn.value = '';
    roundIx = -1;
    watch(r.data.job, stage === 'look' ? 'キービジュアルの候補を生成中' : '動きの案を生成中');
  }

  /** Moves the project forward: look → the chosen key visual; motion → build the work from the liked studies. */
  async function advance() {
    if (!project || job) return;
    if (view === 'look') {
      const chosen = selected ?? currentRound()?.items.find((i) => i.rating === 1 && i.file)?.id ?? null;
      if (!chosen) return status('キービジュアルにする画像の「決定」を押してください', 'err');
      const r = await postJson<Project>(`${API}/project/choose`, { id: project.id, keyVisual: chosen });
      if (!r.ok) return status(r.data.error ?? '決定できません', 'err');
      project = r.data;
      selected = null;
      view = 'motion';
      roundIx = -1;
      render();
      if (!roundsOf('motion').length) await nextRound();
      return;
    }
    const studies = roundsOf('motion').flatMap((r) => r.items).filter((i) => i.rating === 1 && i.file).map((i) => i.id);
    if (!studies.length) return status('作品にしたい動きの案に ♥ を付けてください', 'err');
    const c = await postJson<Project>(`${API}/project/choose`, { id: project.id, studies });
    if (!c.ok) return status(c.data.error ?? '選べません', 'err');
    project = c.data;
    const b = await postJson<{ job?: string }>(`${API}/project/build`, { id: project.id, ...director() });
    if (!b.ok || !b.data.job) return status(b.data.error ?? `作品にできません (${b.status})`, 'err');
    logEl.replaceChildren();
    const run: EditRun = { ...director(), mode: 'create', workId: project.id, message: `「${project.title}」を作品にする（♥ の動き ${studies.length} 案）` };
    resumeEdit(run, b.data.job, editCallbacks('作品を組み立て中'), setHandle('作品を組み立て中'));
  }

  async function rate(item: Item, rating: -1 | 0 | 1, note?: string) {
    if (!project) return;
    const r = await postJson<Project>(`${API}/project/rate`, { id: project.id, item: item.id, rating, note });
    if (r.ok) project = r.data;
    render();
  }

  async function startLora() {
    loraLine.textContent = 'Pinterest LoRA を起動中…（約1分）';
    await postJson(`${API}/lora/start`, {});
    void pollLora();
  }
  async function pollLora() {
    lora = await getJson<LoraStatus>(`${API}/lora/status`);
    paintLora();
    if (lora?.running && lora.phase === 'loading') setTimeout(() => void pollLora(), 3000);
  }
  function paintLora() {
    if (!lora) loraLine.textContent = 'Pinterest LoRA の状態が分かりません';
    else if (!lora.installed) loraLine.textContent = 'Pinterest LoRA が見つかりません';
    else if (!lora.running) loraLine.textContent = 'Pinterest LoRA 停止中（生成時に自動で起動）';
    else loraLine.textContent = `Pinterest LoRA ${lora.phase === 'loading' ? '読み込み中…' : '準備 OK'}`;
    loraStart.hidden = !lora || !lora.installed || lora.running;
  }

  // ======================================================================================== jobs
  function status(text: string, kind: 'run' | 'ok' | 'err' | '' = '') {
    statusEl.textContent = text;
    statusEl.className = `mono jstatus ${kind}`;
  }
  function logLine(type: AgentEvent['type'], text: string) {
    if (type === 'item') return;
    logEl.append(h('div', { class: `ev ${type}` }, type === 'tool' ? `› ${text}` : text));
    while (logEl.childElementCount > 120) logEl.firstElementChild?.remove();
    logEl.scrollTop = logEl.scrollHeight;
  }
  const setHandle = (label: string) => (hd: JobHandle | null) => {
    job = hd ? { handle: hd, started: job?.started ?? Date.now(), label } : null;
    render();
  };

  /** Follows a round job: items arrive one by one, the director's notes come with the first item. */
  function watch(jobId: string, label: string) {
    logEl.replaceChildren();
    let pending = false;
    const refresh = () => {
      if (pending) return;
      pending = true;
      setTimeout(() => { pending = false; void reload(); }, 250);
    };
    const handle = follow(jobId, {
      reset: () => logEl.replaceChildren(),
      event: (e) => {
        if (e.type === 'item') return refresh();
        logLine(e.type, e.text);
        if (e.type === 'done') {
          job = null;
          status('できました。気に入ったものに ♥、違うものに ✕、言葉で FB して次のラウンドへ。', 'ok');
          void reload();
          void pollLora();
        } else if (e.type === 'error') {
          job = null;
          status(e.text.slice(0, 300), 'err');
          void reload();
        } else refresh();
      },
    });
    job = { handle, started: Date.now(), label };
    status(label, 'run');
    void reload();
  }

  async function stopJob() {
    if (!job) return;
    await cancel(job.handle.id);
    job.handle.close();
    job = null;
    status('中止しました', 'err');
    void reload();
  }

  function editCallbacks(label: string): EditCallbacks {
    return {
      turn: (run) => {
        logEl.append(h('div', { class: `ev you${run.attempt ? ' repair' : ''}` }, run.attempt ? `自動修復 ${run.attempt}/${MAX_REPAIRS}` : run.message));
        status(label, 'run');
      },
      line: logLine,
      state: (s) => {
        if (s === 'done') {
          status('完了しました。Perform で確かめてください。', 'ok');
          void reload();
          void loadVersions();
        } else if (s === 'error') status('うまくいきませんでした。ログを見て FB してください。', 'err');
        else if (s === 'cancelled') status('中止しました', 'err');
        else if (s === 'verifying') status('プレビューで検証中…', 'run');
      },
      verify: host.verify,
      autoRepair: () => prefs.autoRepair,
    };
  }

  async function sendFix() {
    const target = fixPicked ?? host.current()?.id ?? null;
    const message = fixIn.value.trim();
    if (!target || !message || job) return;
    const run: EditRun = { ...pickNow(), mode: 'feedback', workId: target, message, snapshot: prefs.attach ? await host.capture() : undefined };
    logEl.replaceChildren();
    tab = 'make'; // the log lives in the make tab
    const failed = await runEdit(run, editCallbacks(`${target} を修正中`), setHandle(`${target} を修正中`));
    if (failed) status(failed, 'err');
    else fixIn.value = '';
    render();
  }

  async function loadVersions() {
    const work = fixPicked ?? host.current()?.id;
    if (!work) return void versions.replaceChildren();
    const list = (await getJson<Version[]>(`/__shiki/history?work=${encodeURIComponent(work)}`)) ?? [];
    if (!list.length) return void versions.replaceChildren(h('p', { class: 'note' }, 'FB を送ると、その直前の状態がここに残ります。'));
    versions.replaceChildren(
      ...list.map((v) => {
        const btn = h('button', { type: 'button', class: 'btn' }, '戻す');
        let armed = false;
        btn.addEventListener('click', async () => {
          if (!armed) {
            armed = true;
            btn.textContent = '本当に？';
            btn.classList.add('live');
            setTimeout(() => { armed = false; btn.textContent = '戻す'; btn.classList.remove('live'); }, 3000);
            return;
          }
          await postJson('/__shiki/history/restore', { work, version: v.version });
          void loadVersions();
        });
        const when = v.at ? new Date(v.at).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : v.version;
        return h('div', { class: 'ver' },
          h('div', {},
            h('div', { class: 'mono vmeta' }, `${when}${v.agent ? ` · ${v.agent} ${v.model ?? ''} ${v.effort ?? ''}` : ''}`),
            h('div', { class: 'vmsg' }, v.restore ? '↩ 版を戻す直前の状態' : v.attempt ? `自動修復 ${v.attempt} の前` : `「${(v.message ?? '').slice(0, 60)}」の前`),
          ),
          btn,
        );
      }),
    );
  }

  // ======================================================================================== render
  const roundsOf = (stage: 'look' | 'motion') => project?.rounds.filter((r) => r.stage === stage) ?? [];
  function currentRound(): Round | null {
    const rs = roundsOf(view);
    if (!rs.length) return null;
    return rs[roundIx < 0 || roundIx >= rs.length ? rs.length - 1 : roundIx];
  }
  const allItems = () => project?.rounds.flatMap((r) => r.items) ?? [];
  const itemById = (id: string | null) => allItems().find((i) => i.id === id) ?? null;

  function zoom(it: Item) {
    if (!project || !it.file) return;
    zoomTo(fileUrl(project.id, it.file), it.title, it.motion, it.prompt);
  }
  function zoomTo(src: string, title: string, motion: string | undefined, prompt: string) {
    zoomEl.replaceChildren(
      h('img', { src, alt: title }),
      h('div', { class: 'zcap' },
        h('strong', { class: 'name' }, title),
        motion ? h('p', { class: 'jp2' }, motion) : null,
        h('p', { class: 'mono zp' }, prompt)),
    );
    zoomEl.hidden = false;
  }

  // ---------------------------------------------------------------------------------------- ♥ library
  const likeUrl = (e: LikeEntry) => `${API}/likes/file?path=${encodeURIComponent(e.file)}`;
  async function loadLikes() {
    const r = await getJson<{ dir: string; items: LikeEntry[] }>(`${API}/likes`);
    likes = r?.items ?? [];
    likesDir = r?.dir ?? '';
    render();
  }
  async function unlike(e: LikeEntry) {
    await postJson(`${API}/project/rate`, { id: e.project, item: e.item, rating: 0 });
    if (project?.id === e.project) await reload();
    await loadLikes();
  }
  /** Puts a liked image (from any project) into the open project's references. */
  async function useAsRef(e: LikeEntry) {
    if (!project) return status('参考画像に使うには、先に制作を開いてください', 'err');
    const blob = await (await fetch(likeUrl(e))).blob();
    await addRefs([new File([blob], `${e.item}.png`, { type: 'image/png' })]);
    status(`「${e.title}」を参考画像に加えました`, 'ok');
  }
  function likeCard(e: LikeEntry) {
    const when = new Date(e.likedAt).toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' });
    return h('article', { class: `card ${e.stage} liked` },
      h('div', { class: 'screen scan' },
        h('img', { src: likeUrl(e), alt: e.title, loading: 'lazy' }),
        h('span', { class: `chip eng${e.engine === 'pinterest-lora' ? ' pin' : ''}` }, `${e.stage === 'motion' ? 'Motion' : 'Key'} · ${e.engine === 'pinterest-lora' ? 'Pinterest' : 'GPT'}`),
        h('button', { type: 'button', class: 'zoom', title: '大きく見る', 'aria-label': '大きく見る', onclick: () => zoomTo(likeUrl(e), e.title, e.motion, e.prompt) }, '⤢'),
      ),
      h('div', { class: 'ctitle' },
        h('strong', { class: 'name' }, e.title),
        h('span', { class: 'rbs' },
          h('button', { type: 'button', class: 'rb pickb', title: '開いている制作の参考画像にする', onclick: () => void useAsRef(e) }, '参考に'),
          h('button', { type: 'button', class: 'rb on', title: '♥ を外す（ライブラリからも消えます）', onclick: () => void unlike(e) }, '♥'),
        ),
      ),
      h('span', { class: 'lbl', style: 'font-size:9px' }, `${e.projectTitle} · ${when}`),
      e.note ? h('p', { class: 'cmotion jp2' }, e.note) : null,
    );
  }

  function card(it: Item, stage: 'look' | 'motion') {
    const p = project!;
    const isKv = p.keyVisual === it.id;
    const img = it.file ? h('img', { src: fileUrl(p.id, it.file), alt: it.title, loading: 'lazy' }) : null;
    const shade = it.status === 'done'
      ? null
      : h('div', { class: `pend ${it.status}` }, it.status === 'error' ? `失敗\n${(it.error ?? '').slice(0, 160)}` : it.status === 'running' ? '描いています…' : '順番待ち');
    const noteIn = h('input', { type: 'text', class: 'note-in', value: it.note, placeholder: 'この画像へのひとこと', 'aria-label': `${it.title} へのコメント` });
    stopKeys(noteIn);
    noteIn.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) noteIn.blur();
    });
    noteIn.addEventListener('change', () => void rate(it, it.rating, noteIn.value));
    const like = h('button', { type: 'button', class: `rb${it.rating === 1 ? ' on' : ''}`, title: 'いいね', 'aria-pressed': String(it.rating === 1), onclick: () => void rate(it, it.rating === 1 ? 0 : 1) }, '♥');
    const nope = h('button', { type: 'button', class: `rb no${it.rating === -1 ? ' on' : ''}`, title: '違う', 'aria-pressed': String(it.rating === -1), onclick: () => void rate(it, it.rating === -1 ? 0 : -1) }, '✕');
    const choose = stage === 'look' && it.file
      ? h('button', { type: 'button', class: `rb pickb${selected === it.id || isKv ? ' on' : ''}`, title: 'これをキービジュアルにする', onclick: () => { selected = it.id; render(); } }, isKv ? '決定済' : '決定')
      : null;
    const cls = ['card', stage, it.rating === 1 && 'liked', it.rating === -1 && 'rej', isKv && 'kv', selected === it.id && 'sel'].filter(Boolean).join(' ');
    return h('article', { class: cls },
      h('div', { class: 'screen scan' }, img, shade,
        h('span', { class: `chip eng${it.engine === 'pinterest-lora' ? ' pin' : ''}` }, it.engine === 'pinterest-lora' ? 'Pinterest' : 'GPT'),
        img ? h('button', { type: 'button', class: 'zoom', title: '大きく見る', 'aria-label': '大きく見る', onclick: () => zoom(it) }, '⤢') : null,
      ),
      h('div', { class: 'ctitle' }, h('strong', { class: 'name' }, it.title || it.id), h('span', { class: 'rbs' }, like, nope, choose)),
      it.motion ? h('p', { class: 'cmotion jp2' }, it.motion) : null,
      noteIn,
    );
  }

  function render() {
    const p = project;
    const busy = !!job;
    // steps
    const at = !p ? 0 : p.stage === 'look' ? 1 : p.stage === 'motion' ? 2 : p.stage === 'build' ? 3 : 4;
    stepEls.forEach((s, i) => (s.className = `s${i < at ? ' dn' : i === at ? ' now' : ''}`));

    // left
    const refs = p ? p.refs.map((r) => ({ url: fileUrl(p.id, r), key: r })) : pendingRefs.map((u, i) => ({ url: u, key: String(i) }));
    refsEl.replaceChildren(
      ...refs.map((r) => h('div', { class: 'ref' }, h('img', { src: r.url, alt: '参考画像' }),
        h('button', {
          type: 'button', class: 'rx', 'aria-label': '外す',
          onclick: () => {
            if (p) void removeRef(r.key);
            else {
              pendingRefs.splice(Number(r.key), 1);
              render();
            }
          },
        }, '×'))),
    );
    startBtn.hidden = !!p;
    slugIn.hidden = !!p;
    const kv = itemById(p?.keyVisual ?? null);
    kvBox.replaceChildren(
      ...(kv?.file && p
        ? [
            h('div', { class: 'gh' }, h('span', { class: 't' }, h('span', { class: 'lbl', style: 'color:#ece6da' }, 'Key visual'), h('span', { class: 'jp' }, '決定'))),
            h('div', { class: 'screen scan kvimg' }, h('img', { src: fileUrl(p.id, kv.file), alt: kv.title })),
            h('span', { class: 'name', style: 'font-size:11px' }, kv.title),
          ]
        : []),
    );
    const lastGood = [...allItems()].reverse().find((i) => i.file && i.rating !== -1);
    host.setBackground(p && kv?.file ? fileUrl(p.id, kv.file) : p && lastGood?.file ? fileUrl(p.id, lastGood.file) : null);

    // center
    viewBtns.look.classList.toggle('on', !likesOpen && view === 'look');
    viewBtns.motion.classList.toggle('on', !likesOpen && view === 'motion');
    viewBtns.likes.classList.toggle('on', likesOpen);
    viewBtns.motion.disabled = !p?.keyVisual;
    const rs = roundsOf(view);
    const cur = currentRound();
    if (likesOpen) {
      roundsNav.replaceChildren(
        h('span', { class: 'mono', style: 'font-size:10px;color:#a3a8a2;align-self:center' }, `${likes.length} 枚`),
        h('button', { type: 'button', class: 'rnd', title: likesDir, onclick: () => void postJson(`${API}/likes/reveal`, {}) }, 'Finder で開く'),
      );
      notesEl.replaceChildren(h('div', { class: 'mono thinking', style: 'color:#a3a8a2' }, `♥ を付けた画像はここに保存されます（プロンプトとひとこと付き）：${likesDir}`));
      grid.className = 'gallery look';
      grid.replaceChildren(...likes.map(likeCard));
      empty.textContent = 'まだ ♥ はありません。キービジュアルや動きの案に ♥ を付けると、ここに集まります。';
      empty.hidden = likes.length > 0;
    } else {
    roundsNav.replaceChildren(
      ...rs.map((r, i) => h('button', { type: 'button', class: `rnd${cur === r ? ' on' : ''}`, onclick: () => { roundIx = i; render(); } }, `R${r.n}`)),
    );
    notesEl.replaceChildren(
      ...(cur
        ? [
            cur.feedback ? h('div', { class: 'qfb' }, `「${cur.feedback}」`) : null,
            cur.director.notes
              ? h('div', {}, cur.director.notes)
              : h('div', { class: 'mono thinking' }, `${cur.director.agent} ${cur.director.model} が構想中…`),
          ].filter((x): x is HTMLDivElement => x !== null)
        : []),
    );
    grid.className = `gallery ${view}`;
    grid.replaceChildren(...(cur?.items ?? []).map((it) => card(it, view)));
    empty.textContent = !p
      ? '左に題名とブリーフを書き、参考画像を入れて「画像をつくる」。AI はまず画像から描きます。動きと作品はそのあと。'
      : !cur
        ? view === 'look'
          ? busy ? 'アートディレクターが構想中…' : '右の「最初の候補をつくる」から始めます。'
          : 'キービジュアルが決まりました。右で動きの案（約10）を画像にします。'
        : '';
    empty.hidden = !!cur?.items.length;
    }

    // right
    tabBtns.make.classList.toggle('on', tab === 'make');
    tabBtns.fix.classList.toggle('on', tab === 'fix');
    make.hidden = tab !== 'make';
    fix.hidden = tab !== 'fix';
    if (tab === 'fix' && picker.parentElement !== fixPickerSlot) fixPickerSlot.append(picker);
    if (tab === 'make' && picker.parentElement !== make) make.insertBefore(picker, engines);
    agentBtns.claude.classList.toggle('on', prefs.agent === 'claude');
    agentBtns.codex.classList.toggle('on', prefs.agent === 'codex');
    engines.hidden = view !== 'look';
    motionCount.hidden = view !== 'motion';
    fbIn.placeholder = view === 'look'
      ? '候補を見た感想。何が良くて何が違うか。♥ の画像は次のラウンドの参考になり、✕ は避けます。'
      : 'どの動きが良いか、どう動いてほしいか。♥ を付けた案が作品の動きになります。';
    chips.replaceChildren(...(view === 'look' ? CHIPS_LOOK : CHIPS_MOTION).map((c) => h('button', { type: 'button', class: 'chip', onclick: () => addTo(fbIn, c) }, c)));
    roundBtn.textContent = !cur ? (view === 'look' ? '最初の候補をつくる' : `動きの案を ${counts.motion} つくる`) : '次のラウンド ⌘⏎';
    roundBtn.disabled = busy || !p || (view === 'motion' && !p.keyVisual);
    cancelBtn.disabled = !busy;
    advanceBtn.textContent = view === 'look' ? '決定した画像で次へ → 動き' : p?.workId ? `作品 ${p.workId} を作り直す →` : '♥ の動きで作品にする →';
    advanceBtn.disabled = busy || !p || !cur;

    // fix tab
    const curWork = host.current();
    if ((curWork?.id ?? null) !== fixSeen) {
      fixSeen = curWork?.id ?? null;
      fixPicked = null;
    }
    const tid = fixPicked ?? curWork?.id ?? null;
    fixTarget.replaceChildren(...host.works().map((w) => h('option', { value: w.id, selected: w.id === tid }, `${w.id === curWork?.id ? curWork.name : w.name}${w.broken ? '  ⚠ 動いていない' : ''}`)));
    fixSend.disabled = busy || !tid;
  }

  // ======================================================================================== start
  window.addEventListener('paste', (e) => {
    if (tab !== 'make' || !el.isConnected || el.offsetParent === null) return;
    const files = [...(e.clipboardData?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    if (files.length) void addRefs(files);
  });
  void (async () => {
    options = await agentOptions();
    fillPicker();
    await loadProjects();
    let last: string | null = null;
    try {
      last = localStorage.getItem('shiki.studio.project');
    } catch {
      /* storage unavailable */
    }
    if (last && projects.some((p) => p.id === last)) await openProject(last);
    else render();
    void pollLora();
    void loadVersions();
    // Re-attach to a job that is still running (e.g. after a reload).
    const jobs = (await getJson<JobRow[]>('/__shiki/agent/jobs')) ?? [];
    const live = jobs.find((j) => j.state === 'running');
    if (live?.kind === 'round' && live.projectId) {
      if (live.projectId !== (project as Project | null)?.id) await openProject(live.projectId);
      watch(live.id, '生成中');
    } else if (live) {
      resumeEdit({ agent: live.agent, model: live.model, effort: live.effort, mode: live.mode, workId: live.workId, message: live.message }, live.id, editCallbacks('作業中'), setHandle('作業中'));
    }
  })();
  render();

  return {
    el,
    pgm,
    refresh() {
      render();
      void loadVersions();
    },
    frame() {
      pgmLabel.textContent = host.current()?.name ?? '';
      // Cut the glass where the GPU draws the on-air monitor (offsets relative to the bar).
      const b = top.getBoundingClientRect();
      const r = pgm.getBoundingClientRect();
      const hx = `${r.left - b.left - 1},${r.top - b.top - 1},${r.width},${r.height}`;
      if (hx !== holeKey) {
        holeKey = hx;
        top.style.setProperty('--hx', `${r.left - b.left - 1}px`);
        top.style.setProperty('--hy', `${r.top - b.top - 1}px`);
        top.style.setProperty('--hw', `${r.width}px`);
        top.style.setProperty('--hh', `${r.height}px`);
      }
      if (job) statusEl.textContent = `${job.label} · ${clock(Date.now() - job.started)}`;
    },
  };
}
