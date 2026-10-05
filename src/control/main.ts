import '../../design/tokens/shiki.css';
import '../../design/tokens/immersive.css';
import './app.css';
import './studio.css';
import { DeckEngine } from '../engine/DeckEngine';
import { GpuDeckEngine } from '../engine/gpu/DeckEngine';
import type { Deck, Rect } from '../engine/DeckEngine';
import { Clock } from '../engine/Clock';
import { AudioEngine } from '../audio/AudioEngine';
import { BeatTracker } from '../audio/BeatTracker';
import { Choreography } from '../audio/Choreography';
import { openBridge } from '../bridge';
import { h } from './dom';
import { mountPerform } from './perform';
import type { TakeOpts } from './perform';
import { mountStudio } from './studio';
import { agentOptions, loadPrefs, resolvePick, runEdit } from './jobs';
import type { JobHandle } from './jobs';
import { loadWorks, onWorksChanged } from '../works/registry';
import type { LoadResult } from '../works/registry';
import { SILENT } from '../engine/types';
import type { InstrumentModule, LiveSignals } from '../engine/types';

const TEST_TRACK = '/test/testtrack-128.wav';
const DECKS = ['A', 'B'] as const;
const other = (d: Deck): Deck => (d === 'A' ? 'B' : 'A');
type Screen = 'perform' | 'studio';

// ---------- state ----------
let list: InstrumentModule[] = [];
/** The last registry load (both engines' works), to tell "built for the other engine" from "missing". */
let lastLoad: LoadResult | null = null;
let art: Record<string, string> = {};
const clock = new Clock();
const audio = new AudioEngine();
const tracker = new BeatTracker();
const choreo = new Choreography();
let latest: LiveSignals = { ...SILENT };
let lastNow = performance.now();
let output = { seen: 0, fps: 0, w: 0, h: 0 };
/** Latest error per work id (Studio verification reads it). */
const lastError = new Map<string, { at: number; msg: string }>();
/** Work folders whose module fails to import (syntax errors, missing files). */
const broken = new Set<string>();
/** When each work last loaded fine (a newer error means it does not run right now). */
const loadedAt = new Map<string, number>();
/** The deck whose macros the panel shows and whose work the Studio edits by default. */
let editDeck: Deck = 'A';
let screen: Screen = 'perform';
const takeOpts: TakeOpts = { transition: 'dissolve', beats: 8, quantize: 'bar' };

const bridge = openBridge((m) => {
  if (m.t === 'alive') output = { seen: performance.now(), fps: m.fps, w: m.width, h: m.height };
});

// One canvas behind everything: the program fills it, deck previews are viewports drawn into holes in the glass.
const gl = h('canvas', { class: 'gl' });
function rel(el: HTMLElement): Rect {
  const c = gl.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height };
}

/** The screens are built after the engine; until then the program simply fills the canvas. */
let mounted = false;
/** Rendering backend for this window (and the output window): WebGPU worlds, or the WebGL-era works until ported. */
const engineMode: 'gpu' | 'gl' = (() => {
  try {
    return localStorage.getItem('shiki.engine') === 'gl' ? 'gl' : 'gpu';
  } catch {
    return 'gpu';
  }
})();
const engineOpts: ConstructorParameters<typeof DeckEngine>[0] = {
  canvas: gl,
  maxPixelRatio: 1,
  layout: () => {
    if (!mounted) return null;
    if (screen === 'studio') return { program: rel(studio.pgm), previews: {} };
    return { program: { x: 0, y: 0, w: gl.clientWidth, h: gl.clientHeight }, previews: perform.holes(rel) };
  },
  onError: (msg, work, deck) => pushError(work, deck === 'safe' ? `[safe] ${msg}` : msg),
  onLoad: (id) => {
    loadedAt.set(id, Date.now());
    perform.renderLibrary();
    perform.renderMacros();
  },
};
// Both engines expose the same API; the WebGPU one loads asynchronously (see loadOn) and takes WebGPU modules.
const engine = (engineMode === 'gpu' ? await GpuDeckEngine.create(engineOpts as never) : new DeckEngine(engineOpts)) as unknown as DeckEngine;
/** Fail-safe load on either engine (sync on WebGL, async on WebGPU). */
async function loadOn(deck: Deck, w: InstrumentModule, keepKnobs: boolean): Promise<boolean> {
  return await (engine.load(deck, w, { keepKnobs }) as boolean | Promise<boolean>);
}
async function setSafeOn(w: InstrumentModule): Promise<boolean> {
  return await (engine.setSafe(w) as boolean | Promise<boolean>);
}
const worksOf = (res: LoadResult): InstrumentModule[] => (engineMode === 'gpu' ? (res.gpuWorks as unknown as InstrumentModule[]) : res.works);
engine.setPreview('A', true);
engine.setPreview('B', true);

engine.signals = (now) => {
  const dt = Math.min(0.1, Math.max(0.001, (now - lastNow) / 1000));
  lastNow = now;
  const a = audio.read(dt);
  if (audio.mode !== 'off') tracker.push(a.flux, now);
  clock.followAudio(tracker.estimate(), now);
  const c = clock.state(now);
  const ch = choreo.step(a, dt);
  latest = {
    bpm: c.bpm, beat: c.beat, bar: c.bar, beats: c.beats,
    low: a.low, mid: a.mid, high: a.high, level: a.level, onset: a.onset, kick: a.kick,
    tension: ch.tension, drop: ch.drop,
  };
  bridge.send({
    t: 'state',
    decks: {
      A: { workId: engine.workId('A'), knobs: Array.from(engine.knobs.A) },
      B: { workId: engine.workId('B'), knobs: Array.from(engine.knobs.B) },
    },
    safeId: engine.workId('safe'),
    sync: engine.syncState(),
    signals: latest,
    exposure: engine.exposure,
  });
  return latest;
};

// ---------- actions ----------
const cueDeck = (): Deck => other(engine.onAir);

function find(id: string | null): InstrumentModule | undefined {
  return id ? list.find((x) => x.manifest.id === id) : undefined;
}

async function loadInto(deck: Deck, w: InstrumentModule, keepKnobs = false): Promise<boolean> {
  const ok = await loadOn(deck, w, keepKnobs);
  if (ok) {
    perform.renderLibrary();
    perform.renderMacros();
    studio.refresh();
  }
  return ok;
}

function doTake(opts: Partial<TakeOpts> = {}) {
  if (engine.isSafe) {
    // Leaving safe: cut straight back to the on-air deck.
    engine.onAir = engine.onAir;
    return;
  }
  if (!engine.take({ ...takeOpts, ...opts })) pushError('take', `デッキ ${cueDeck()} に作品がありません`);
}

function goSafe() {
  if (!engine.safe()) pushError('safe', 'セーフ用の作品がありません');
}

function setEditDeck(deck: Deck) {
  editDeck = deck;
  perform.renderMacros();
  studio.refresh();
}

function openOutput() {
  window.open('/output.html', 'shiki-output', 'popup,width=1280,height=720');
}

const fileInput = h('input', { type: 'file', accept: 'audio/*', style: 'display:none', onchange: () => void pickFile() });
async function useMic() {
  try {
    await audio.useMic();
    tracker.reset();
  } catch (err) {
    pushError('audio', `マイクを使えません: ${String(err)}`);
  }
}
async function useTestTrack() {
  try {
    await audio.useFile(TEST_TRACK);
    tracker.reset();
  } catch (err) {
    pushError('audio', `テスト音源がありません（npm run gen:testtrack）: ${String(err)}`);
  }
}
async function pickFile() {
  const f = fileInput.files?.[0];
  if (!f) return;
  try {
    await audio.useFile(f);
    tracker.reset();
  } catch (err) {
    pushError('audio', String(err));
  }
}

/**
 * After an agent finished: waits for the registry to hold the work's latest code (new folders and edits arrive through
 * HMR), then loads it fail-safe into its deck (or, for a new work, the cue deck — cut on air only while in the Studio).
 * Returns the load/compile error, or null.
 */
async function verifyWork(id: string): Promise<string | null> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const since = Date.now();
  await sleep(1500);
  for (let i = 0; i < 16 && !find(id); i++) await sleep(500);
  const w = find(id);
  if (!w) {
    const other = engineMode === 'gpu' ? lastLoad?.works : (lastLoad?.gpuWorks as unknown as InstrumentModule[] | undefined);
    if (other?.some((x) => x.manifest.id === id))
      return engineMode === 'gpu'
        ? `works/${id} は WebGL 用（defineInstrument + GLSL）で作られていますが、プラットフォームは WebGPU で動いています。AGENTS.md の "WebGPU worlds" に従い、works/_starter/index.ts を雛形に defineGpuInstrument で作り直してください。`
        : `works/${id} は WebGPU 用です。ヘッダーで WebGPU に切り替えると読み込めます。`;
    const e = lastError.get(id);
    return e && e.at >= since - 120_000 ? e.msg : `works/${id} が作品一覧に現れません（manifest.id とフォルダ名が一致していない可能性）`;
  }
  const before = Date.now();
  const home = DECKS.find((d) => engine.workId(d) === id);
  const deck = home ?? cueDeck();
  if (await loadInto(deck, w, home !== undefined)) {
    if (!home) {
      if (screen === 'studio') engine.onAir = deck;
      setEditDeck(deck);
    }
    return null;
  }
  const e = lastError.get(id);
  return e && e.at >= before ? e.msg : '読み込みに失敗しました（詳細なし）';
}

/** Perform's AI prompt: feedback to the work on the cue deck (live, the AI only rewrites what is not on air). */
let quickJob: JobHandle | null = null;
async function quickFeedback(text: string, status: (s: string, kind?: 'run' | 'ok' | 'err') => void) {
  const id = engine.workId(cueDeck());
  if (!id) return status(`デッキ ${cueDeck()} に作品がありません`, 'err');
  if (quickJob) return status('前の指示を処理中です', 'err');
  const prefs = loadPrefs();
  const pick = resolvePick(await agentOptions(), prefs);
  const started = Date.now();
  const tick = () => `${pick.agent} ${pick.model} ${pick.effort} · ${Math.round((Date.now() - started) / 1000)}s`;
  status(`${id} を修正中 · ${tick()}`, 'run');
  const failed = await runEdit({ ...pick, mode: 'feedback', workId: id, message: text }, {
    turn: () => {},
    line: (type, t) => {
      if (type === 'text' || type === 'tool') status(`${tick()} · ${t.replace(/\s+/g, ' ').slice(0, 90)}`, 'run');
    },
    state: (s) => {
      if (s === 'done') status(`反映しました → DECK ${DECKS.find((d) => engine.workId(d) === id) ?? ''} · ${id}`, 'ok');
      else if (s === 'error') status('うまくいきませんでした（Studio のログを確認）', 'err');
      else if (s === 'cancelled') status('中止しました', 'err');
      else if (s === 'verifying') status(`${id} を検証中…`, 'run');
    },
    verify: verifyWork,
    autoRepair: () => loadPrefs().autoRepair,
  }, (handle) => (quickJob = handle));
  if (failed) status(failed, 'err');
}

// ---------- screens ----------
const studioBg = h('img', { class: 'studio-bg', alt: '', style: 'opacity:0' });
const toasts = h('div', { class: 'toasts', 'aria-live': 'polite' });
const perform = mountPerform({
  engine,
  signals: () => latest,
  works: () => list,
  art: (id) => art[id],
  editDeck: () => editDeck,
  setEditDeck,
  cueDeck,
  loadInto: (deck, w) => loadInto(deck, w),
  take: doTake,
  takeOpts,
  goSafe,
  openOutput,
  build: (on) => { choreo.building = on; },
  drop: () => choreo.fire(),
  audio: {
    mode: () => audio.mode,
    label: () => audio.label,
    mic: () => void useMic(),
    test: () => void useTestTrack(),
    file: () => fileInput.click(),
    off: () => { audio.stop(); tracker.reset(); },
  },
  quickFeedback,
});

const studio = mountStudio({
  works: () => {
    const loaded = new Set(DECKS.map((d) => engine.workId(d)));
    const all = [
      ...list.map((w) => ({ id: w.manifest.id, name: w.manifest.name })),
      ...[...broken].filter((id) => !find(id)).map((id) => ({ id, name: id })),
    ];
    return all.map((w) => ({ ...w, broken: broken.has(w.id) || (!loaded.has(w.id) && (lastError.get(w.id)?.at ?? 0) > (loadedAt.get(w.id) ?? 0)) }));
  },
  current: () => {
    const m = engine.manifest(editDeck);
    return m ? { id: m.id, name: `${m.name}（デッキ ${editDeck}）` } : null;
  },
  capture: () => new Promise<string>((done) => requestAnimationFrame(() => done(grab(programRect(), 0.85)))),
  verify: verifyWork,
  setBackground: (url) => {
    if (url) studioBg.src = url;
    studioBg.style.opacity = url ? '1' : '0';
  },
  openPerform: () => setScreen('perform'),
});

// ---------- header ----------
const clockSrc = h('button', { type: 'button', class: 'clksrc mono', title: 'クリックで音への自動追従を切り替え', onclick: () => toggleFollow() },
  h('span', {}, 'Tap clock'), h('i', { class: 'dot breathe' }));
const bpmEl = h('span', { class: 'num', style: 'font-size:28px' });
const barEl = h('span', { class: 'num', style: 'font-size:28px' });
const beatDots = Array.from({ length: 16 }, () => h('i'));
const phraseCells = Array.from({ length: 32 }, (_, i) => h('i', { class: i % 8 === 0 ? 'mk' : '' }));
const outEl = h('span', { class: 'mono' });
const fpsEl = h('span', { class: 'mono' });
const ttl = h('span', { class: 'ttl' }, 'PERFORM');
const sub = h('span', { class: 'lbl', style: 'font-size:8.5px;letter-spacing:.2em' }, 'Visuals for music');
const segBtns = {
  perform: h('button', { type: 'button', onclick: () => setScreen('perform') }, 'PERFORM'),
  studio: h('button', { type: 'button', onclick: () => setScreen('studio') }, 'STUDIO'),
};
const header = h('header', { class: 'topi' },
  h('div', { class: 'bl' },
    h('span', { class: 'wm' }, 'SHIKI'),
    h('i', { class: 'slash', 'aria-hidden': 'true' }),
    h('span', { class: 'stack2', style: 'gap:3px' }, ttl, sub),
    h('nav', { class: 'mseg', 'aria-label': '画面' }, segBtns.perform, segBtns.studio),
  ),
  h('div', { class: 'clk' },
    clockSrc,
    h('i', { class: 'sep' }),
    h('span', { style: 'display:flex;align-items:flex-end;gap:6px' }, bpmEl, h('span', { class: 'lbl', style: 'padding-bottom:2px' }, 'BPM')),
    h('span', { style: 'display:flex;align-items:flex-end;gap:6px' }, barEl, h('span', { class: 'lbl', style: 'padding-bottom:2px' }, 'Bar')),
    h('div', { class: 'stack2', style: 'gap:7px' },
      h('div', { class: 'bd', 'aria-hidden': 'true' }, ...[0, 1, 2, 3].map((b) => h('span', {}, ...beatDots.slice(b * 4, b * 4 + 4)))),
      h('div', { class: 'cells', 'aria-hidden': 'true' }, ...phraseCells),
    ),
    h('div', { style: 'display:flex;gap:6px' },
      h('button', { type: 'button', class: 'btn', style: 'min-width:54px', onclick: () => clock.tap() }, 'Tap'),
      h('button', { type: 'button', class: 'btn', 'aria-label': '位相を早める', style: 'width:32px;padding:0', onclick: () => clock.nudge(-10) }, '−'),
      h('span', { class: 'lbl', style: 'align-self:center' }, 'Nudge'),
      h('button', { type: 'button', class: 'btn', 'aria-label': '位相を遅らせる', style: 'width:32px;padding:0', onclick: () => clock.nudge(10) }, '+'),
      h('button', { type: 'button', class: 'btn', onclick: () => clock.downbeat() }, 'Downbeat'),
    ),
  ),
  h('div', { class: 'st' },
    h('button', {
      type: 'button', class: 'btn', title: 'WebGPU の世界と、移植前の WebGL の作品を切り替えます（再読み込み）',
      onclick: () => {
        try {
          localStorage.setItem('shiki.engine', engineMode === 'gpu' ? 'gl' : 'gpu');
        } catch {
          /* storage unavailable */
        }
        location.reload();
      },
    }, engineMode === 'gpu' ? 'WebGPU' : 'WebGL'),
    h('span', { class: 'stack2', style: 'gap:2px;align-items:flex-end' }, outEl, fpsEl)),
);

const app = h('div', { class: 'app imm' },
  gl, studioBg, h('div', { class: 'vig' }), h('div', { class: 'scanl' }),
  h('div', { class: 'shell' }, header, perform.el, studio.el),
  toasts, fileInput,
);
document.getElementById('app')!.append(app);
mounted = true;

function setScreen(s: Screen) {
  screen = s;
  app.dataset.screen = s;
  ttl.textContent = s === 'perform' ? 'PERFORM' : 'STUDIO';
  sub.textContent = s === 'perform' ? 'Visuals for music' : 'Image first';
  segBtns.perform.classList.toggle('on', s === 'perform');
  segBtns.studio.classList.toggle('on', s === 'studio');
  try {
    localStorage.setItem('shiki.screen', s);
  } catch {
    /* storage unavailable */
  }
  if (s === 'studio') studio.refresh();
}
let initialScreen: string | null = null;
try {
  initialScreen = localStorage.getItem('shiki.screen');
} catch {
  /* storage unavailable */
}
setScreen(initialScreen === 'studio' ? 'studio' : 'perform');

function toggleFollow() {
  clock.follow = !clock.follow;
  if (!clock.follow && clock.source === 'audio') clock.source = 'tap';
}

// ---------- works ----------
function applyWorks(res: LoadResult) {
  lastLoad = res;
  list = worksOf(res);
  art = res.art;
  broken.clear();
  for (const e of res.errors) {
    broken.add(e.id);
    pushError(e.id, `読み込めません（ほかの作品は動き続けます）\n${e.error}`);
  }
  for (const deck of DECKS) {
    const w = find(engine.workId(deck));
    if (w) void loadOn(deck, w, true);
  }
  const safe = find(engine.workId('safe'));
  if (safe) void setSafeOn(safe);
  perform.renderLibrary();
  perform.renderMacros();
  studio.refresh();
}
onWorksChanged(applyWorks);

// ---------- errors ----------
function pushError(work: string, msg: string) {
  console.warn(`[shiki] ${work}: ${msg}`);
  lastError.set(work, { at: Date.now(), msg });
  const t = h('div', { class: 'glass toast', role: 'status', onclick: () => t.remove() }, h('b', {}, work), `\n${msg.slice(0, 600)}`);
  toasts.prepend(t);
  while (toasts.childElementCount > 3) toasts.lastElementChild?.remove();
  setTimeout(() => t.remove(), 9000);
}

// ---------- keys ----------
window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null;
  if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || (t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range'))) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const big = e.shiftKey;
  switch (e.key) {
    case ' ': e.preventDefault(); clock.tap(); break;
    case 'ArrowLeft': e.preventDefault(); clock.nudge(big ? -40 : -10); break;
    case 'ArrowRight': e.preventDefault(); clock.nudge(big ? 40 : 10); break;
    case 'ArrowUp': e.preventDefault(); clock.setBpm(clock.bpm + (big ? 5 : 0.5)); break;
    case 'ArrowDown': e.preventDefault(); clock.setBpm(clock.bpm - (big ? 5 : 0.5)); break;
    case 'd': case 'D': clock.downbeat(); break;
    case 'Enter': e.preventDefault(); choreo.fire(); break;
    case 'b': case 'B': choreo.building = true; break;
    case 't': case 'T': doTake(); break;
    case 'x': case 'X': doTake({ transition: 'cut', quantize: 'now' }); break;
    case 'Escape': engine.blackout(!engine.isBlackout); break;
    case 'z': case 'Z': engine.freeze(!engine.isFrozen); break;
    case 's': case 'S': goSafe(); break;
    case 'o': case 'O': openOutput(); break;
    case 'h': case 'H': perform.toggleTitle(); break;
    case 'Tab': e.preventDefault(); setScreen(screen === 'perform' ? 'studio' : 'perform'); break;
    default:
      if (/^[1-9]$/.test(e.key)) {
        const w = list[Number(e.key) - 1];
        if (w) void loadInto(cueDeck(), w);
      }
  }
});
window.addEventListener('keyup', (e) => {
  if (e.key === 'b' || e.key === 'B') choreo.building = false;
});

// ---------- UI loop ----------
const deckSince: Record<Deck, { id: string | null; at: number }> = { A: { id: null, at: 0 }, B: { id: null, at: 0 } };
function ui() {
  requestAnimationFrame(ui);
  const alive = performance.now() - output.seen < 2500;
  outEl.textContent = alive ? `OUT ${output.w}×${output.h} · ${output.fps}fps` : 'OUT · closed';
  fpsEl.textContent = `CTRL ${Math.round(engine.fps)}fps`;
  clockSrc.classList.toggle('on', clock.follow);
  (clockSrc.firstElementChild as HTMLElement).textContent = clock.follow
    ? `Audio follow · ${clock.confidence.toFixed(2)}`
    : `${clock.source === 'audio' ? 'Audio' : 'Tap'} clock`;
  bpmEl.textContent = clock.bpm.toFixed(1);
  const beats = Math.max(0, latest.beats);
  const bar = Math.floor(beats / 4);
  barEl.textContent = `${(bar % 32) + 1}.${(Math.floor(beats) % 4) + 1}`;
  const sixteenth = Math.floor(beats * 4) % 16;
  beatDots.forEach((d, i) => {
    d.className = i < sixteenth ? 'dn' : i === sixteenth ? 'on' : '';
  });
  phraseCells.forEach((c, i) => {
    c.className = (i < bar % 32 ? 'dn' : i === bar % 32 ? 'on' : '') + (i % 8 === 0 ? ' mk' : '');
  });
  if (screen === 'perform') {
    perform.frame();
    // Works without a key visual get a library thumbnail from their deck preview once they have run for a moment.
    for (const d of DECKS) {
      const id = engine.workId(d);
      if (deckSince[d].id !== id) deckSince[d] = { id, at: performance.now() };
      if (id && !art[id] && !perform.hasThumb(id) && performance.now() - deckSince[d].at > 2500) {
        const r = perform.holes(rel)[d];
        if (r && r.w > 10) perform.setThumb(id, grab(r, 0.8));
      }
    }
  } else studio.frame();
}

// ---------- automation hooks (dev only) ----------
/** A region of the last rendered frame as a JPEG data URL. Call right after a render. */
function grab(r: Rect, quality = 0.9): string {
  const k = gl.width / Math.max(1, gl.clientWidth);
  const w = Math.max(2, Math.round(r.w * k));
  const hh = Math.max(2, Math.round(r.h * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hh;
  c.getContext('2d')!.drawImage(gl, Math.round(r.x * k), Math.round(r.y * k), w, hh, 0, 0, w, hh);
  return c.toDataURL('image/jpeg', quality);
}
function programRect(): Rect {
  return screen === 'studio' ? rel(studio.pgm) : { x: 0, y: 0, w: gl.clientWidth, h: gl.clientHeight };
}

/** Saves the next rendered program frame to .agents/snaps/<name>.jpg via the dev server. */
async function snap(name = 'snap', quality = 0.9): Promise<string> {
  const url = await new Promise<string>((done) => requestAnimationFrame(() => done(grab(programRect(), quality))));
  const res = await fetch(`/__shiki/snap?name=${encodeURIComponent(name)}`, { method: 'POST', body: url });
  return ((await res.json()) as { file: string }).file;
}

/**
 * Deterministic offline capture: renders `seconds` at a fixed `fps` with scripted signals
 * (128 BPM groove → build from `buildAt` with rising tension → drop at `dropAt`), independent of
 * tab visibility or real-time speed. Optional `takeAt` (seconds) schedules the current TAKE settings.
 * Frames go to .agents/frames/<name>/, the result to .agents/clips/<name>.mp4.
 */
async function offline(opts: { name?: string; seconds?: number; fps?: number; buildAt?: number; dropAt?: number; takeAt?: number } = {}) {
  const { name = 'offline', seconds = 14, fps = 30, buildAt = 3, dropAt = 9, takeAt } = opts;
  const bpm = 128;
  const beatS = 60 / bpm;
  const saved = engine.signals;
  engine.stop();
  const t0 = performance.now();
  let frameTime = t0;
  let scripted: LiveSignals = { ...SILENT };
  engine.signals = () => {
    const t = (frameTime - t0) / 1000;
    const beats = t / beatS;
    const building = t >= buildAt && t < dropAt;
    const sinceBeat = (beats % 1) * beatS;
    const kick = building ? 0 : Math.exp(-sinceBeat / 0.14);
    scripted = {
      bpm, beats, beat: beats % 1, bar: (beats / 4) % 1,
      low: building ? 0.25 : 0.55 + 0.35 * kick, mid: 0.4, high: building ? 0.3 + 0.6 * (t - buildAt) / (dropAt - buildAt) : 0.35,
      level: 0.6, onset: kick, kick,
      tension: building ? Math.min(1, (t - buildAt) / (dropAt - buildAt)) : 0,
      drop: t >= dropAt ? Math.exp(-(t - dropAt) / 2.2) : 0,
    };
    return scripted;
  };
  try {
    const total = Math.round(seconds * fps);
    let took = false;
    for (let i = 0; i < total; i++) {
      frameTime = t0 + (i * 1000) / fps;
      if (takeAt !== undefined && !took && i / fps >= takeAt) {
        took = true;
        engine.take({ ...takeOpts }, scripted.beats);
      }
      engine.renderAt(frameTime);
      await fetch(`/__shiki/frame?name=${encodeURIComponent(name)}&i=${i}`, { method: 'POST', body: grab(programRect(), 0.9) });
    }
  } finally {
    engine.signals = saved;
    engine.start();
  }
  const res = await fetch(`/__shiki/encode?name=${encodeURIComponent(name)}&fps=${fps}`);
  return (await res.json()) as { mp4: string; sheet: string };
}

if (import.meta.env.DEV) {
  Object.assign(window, {
    __shiki: {
      engine, clock, audio, tracker, choreo, snap, offline, take: takeOpts, setScreen,
      /** Puts a work straight on air (automation). */
      select: (id: string) => {
        const w = find(id);
        if (w) void loadInto(engine.onAir, w).then((ok) => ok && setEditDeck(engine.onAir));
        return engine.workId(engine.onAir);
      },
      cue: (id: string) => { const w = find(id); if (w) void loadInto(cueDeck(), w); return engine.workId(cueDeck()); },
      doTake,
      testTrack: useTestTrack,
      signals: () => latest,
    },
  });
}

// ---------- start ----------
const initial = await loadWorks();
for (const e of initial.errors) {
  broken.add(e.id);
  pushError(e.id, `読み込めません（ほかの作品は動き続けます）\n${e.error}`);
}
lastLoad = initial;
list = worksOf(initial);
art = initial.art;
const first = (engineMode === 'gpu' ? find('alien-signal') : find('moonsea')) ?? list[0];
const second = (engineMode === 'gpu' ? undefined : find('ink-tide')) ?? list.find((w) => w !== first) ?? first;
if (first) {
  await loadOn('A', first, false);
  await setSafeOn(first);
}
if (second) await loadOn('B', second, false);
perform.renderLibrary();
perform.renderMacros();
studio.refresh();
engine.start();
ui();
