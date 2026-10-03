import './control.css';
import { DeckEngine } from '../engine/DeckEngine';
import type { Deck, MasterFx, Quantize, Rect, Transition } from '../engine/DeckEngine';
import { Clock } from '../engine/Clock';
import { AudioEngine } from '../audio/AudioEngine';
import { BeatTracker } from '../audio/BeatTracker';
import { Choreography } from '../audio/Choreography';
import { openBridge } from '../bridge';
import { h } from './dom';
import { mountStudio } from './studio';
import { loadWorks, onWorksChanged } from '../works/registry';
import type { LoadResult } from '../works/registry';
import { SILENT } from '../engine/types';
import type { InstrumentModule, LiveSignals } from '../engine/types';

const TEST_TRACK = '/test/testtrack-128.wav';
const DECKS = ['A', 'B'] as const;
const other = (d: Deck): Deck => (d === 'A' ? 'B' : 'A');
const TRANSITIONS: Transition[] = ['dissolve', 'luma-wipe', 'displace', 'feedback-melt', 'cut'];
const QUANTIZE: { id: Quantize; label: string }[] = [
  { id: 'now', label: 'now' }, { id: 'beat', label: 'beat' }, { id: 'bar', label: 'bar' },
  { id: 'phrase16', label: '16' }, { id: 'phrase32', label: '32' },
];
const FX: { id: MasterFx; label: string }[] = [
  { id: 'feedback', label: 'Feedback' }, { id: 'kaleido', label: 'Kaleido' }, { id: 'rgb-split', label: 'RGB split' },
  { id: 'grain', label: 'Grain' }, { id: 'strobe', label: 'Strobe ≤8Hz' },
];

// ---------- state ----------
let list: InstrumentModule[] = [];
const clock = new Clock();
const audio = new AudioEngine();
const tracker = new BeatTracker();
const choreo = new Choreography();
let latest: LiveSignals = { ...SILENT };
let lastNow = performance.now();
let output = { seen: 0, fps: 0, w: 0, h: 0 };
const errors: { at: string; work: string; msg: string }[] = [];
/** Latest error per work id (Studio verification reads it). */
const lastError = new Map<string, { at: number; msg: string }>();
/** Work folders whose module fails to import (syntax errors, missing files). */
const broken = new Set<string>();
/** When each work last loaded fine (a newer error means it does not run right now). */
const loadedAt = new Map<string, number>();
/** The deck whose macros the panel shows and whose work the Studio edits. */
let editDeck: Deck = 'A';
const take = { transition: 'dissolve' as Transition, beats: 8, quantize: 'bar' as Quantize };

const bridge = openBridge((m) => {
  if (m.t === 'alive') output = { seen: performance.now(), fps: m.fps, w: m.width, h: m.height };
});

// One canvas behind the whole stage: the program and both deck previews are viewports of it.
const gl = h('canvas', { class: 'gl' });
const pgmEl = h('div', { class: 'pgm' });
const pvw: Record<Deck, HTMLDivElement> = { A: h('div', { class: 'pvw' }), B: h('div', { class: 'pvw' }) };

function rel(el: HTMLElement): Rect {
  const c = gl.getBoundingClientRect();
  const r = el.getBoundingClientRect();
  return { x: r.left - c.left, y: r.top - c.top, w: r.width, h: r.height };
}

const engine = new DeckEngine({
  canvas: gl,
  maxPixelRatio: 1.5,
  layout: () => ({ program: rel(pgmEl), previews: { A: rel(pvw.A), B: rel(pvw.B) } }),
  onError: (msg, work, deck) => pushError(work, deck === 'safe' ? `[safe] ${msg}` : msg),
  onLoad: (id) => {
    loadedAt.set(id, Date.now());
    renderWorks();
    renderMacros();
  },
});
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

// ---------- layout ----------
const nowName = h('span', { class: 'name' });
const nowJa = h('span', { class: 'jp2' });
const fpsEl = h('span', { class: 'lbl' });
const outEl = h('span', { class: 'lbl' });
const pgmState = h('span', { class: 'pstate' });
const worksEl = h('div', { class: 'works' });
const macrosTitle = h('span', { class: 'lbl' });
const macrosEl = h('div', { class: 'col', style: 'display:flex;flex-direction:column;gap:12px' });
const presetsEl = h('div', { class: 'row' });
const bpmEl = h('span', { class: 'num bpm' });
const clockSrcEl = h('span', { class: 'lbl' });
const beatsEl = h('div', { class: 'beats' }, h('i'), h('i'), h('i'), h('i'));
const followBtn = h('button', { class: 'btn', type: 'button', onclick: () => toggleFollow() }, 'Audio follow');
const audioLabel = h('span', { class: 'note' });
const meterNames = ['low', 'mid', 'high', 'onset', 'kick', 'tension', 'drop'] as const;
const meterBars = meterNames.map(() => h('i'));
const errorsEl = h('div', { class: 'errors' });
const fileInput = h('input', { type: 'file', accept: 'audio/*', style: 'display:none', onchange: () => void pickFile() });

function deckCard(deck: Deck) {
  const name = h('span', { class: 'dname' });
  const state = h('span', { class: 'dstate' });
  const el = h('div', { class: 'deck', onclick: () => setEditDeck(deck) },
    h('div', { class: 'dhead' }, h('span', { class: 'dk' }, deck), name, state),
    pvw[deck],
  );
  return { el, name, state };
}
const deckUi = { A: deckCard('A'), B: deckCard('B') };

const takeBtn = h('button', { class: 'btn live take', type: 'button', onclick: () => doTake() }, 'TAKE  T');
const takeStatus = h('div', { class: 'tstatus' });
const fader = h('input', {
  type: 'range', min: 0, max: 1, step: 0.001, value: 0, class: 'fader', 'aria-label': 'クロスフェーダー A–B',
  oninput: () => { engine.mix = Number(fader.value); },
});
const panic = {
  black: h('button', { class: 'btn panic', type: 'button', onclick: () => engine.blackout(!engine.isBlackout) }, 'Black  esc'),
  freeze: h('button', { class: 'btn panic', type: 'button', onclick: () => engine.freeze(!engine.isFrozen) }, 'Freeze  Z'),
  safe: h('button', { class: 'btn panic', type: 'button', onclick: () => goSafe() }, 'Safe  S'),
};
const select = <T extends string>(label: string, items: { id: T; label: string }[], value: T, set: (v: T) => void) =>
  h('label', { class: 'tsel' },
    h('span', { class: 'lbl' }, label),
    h('select', { onchange: (e: Event) => set((e.target as HTMLSelectElement).value as T) },
      ...items.map((it) => h('option', { value: it.id, selected: it.id === value }, it.label)),
    ),
  );
const takeCol = h('div', { class: 'takecol' },
  select('Transition', TRANSITIONS.map((t) => ({ id: t, label: t })), take.transition, (v) => { take.transition = v; }),
  h('div', { class: 'tpair' },
    select('Beats', ['1', '2', '4', '8', '16', '32'].map((b) => ({ id: b, label: b })), String(take.beats), (v) => { take.beats = Number(v); }),
    select('Quantize', QUANTIZE, take.quantize, (v) => { take.quantize = v; }),
  ),
  takeBtn,
  takeStatus,
  h('div', { class: 'fwrap' }, h('span', { class: 'lbl' }, 'A'), fader, h('span', { class: 'lbl' }, 'B')),
  h('div', { class: 'panics' }, panic.black, panic.freeze, panic.safe),
);

const fxEl = h('div', { class: 'fxs' },
  ...FX.map(({ id, label }) => {
    const btn = h('button', { class: 'btn fxbtn', type: 'button', onclick: () => { engine.setFx(id, { on: !engine.fx[id].on }); } }, label);
    btn.dataset.fx = id;
    return h('div', { class: 'fx' },
      btn,
      h('input', { type: 'range', min: 0, max: 1, step: 0.001, value: engine.fx[id].amount, 'aria-label': `${label} amount`,
        oninput: (e: Event) => engine.setFx(id, { amount: Number((e.target as HTMLInputElement).value) }) }),
    );
  }),
);

const performEl = h('div', { class: 'perform' });
const tabBtns = {
  perform: h('button', { class: 'tab', type: 'button', onclick: () => showTab('perform') }, 'Perform'),
  studio: h('button', { class: 'tab', type: 'button', onclick: () => showTab('studio') }, 'Studio'),
};
const studio = mountStudio({
  current: () => {
    const m = engine.manifest(editDeck);
    return m ? { id: m.id, name: `${m.name}（デッキ ${editDeck}）` } : null;
  },
  works: () => {
    const loaded = new Set(DECKS.map((d) => engine.workId(d)));
    const all = [
      ...list.map((w) => ({ id: w.manifest.id, name: w.manifest.name })),
      ...[...broken].filter((id) => !find(id)).map((id) => ({ id, name: id })),
    ];
    return all.map((w) => ({ ...w, broken: broken.has(w.id) || (!loaded.has(w.id) && (lastError.get(w.id)?.at ?? 0) > (loadedAt.get(w.id) ?? 0)) }));
  },
  capture: () => new Promise<string>((done) => requestAnimationFrame(() => done(grab(0.85)))),
  verify: verifyWork,
});

const app = document.getElementById('app')!;
app.append(
  h('header', { class: 'top' },
    h('span', { class: 'wm' }, 'SHIKI'),
    h('span', { class: 'lbl' }, 'Step 2 · perform'),
    h('span', { class: 'now' }, h('span', { class: 'air' }, 'ON AIR'), nowName, nowJa),
    h('span', { class: 'spacer' }),
    fpsEl,
    outEl,
    h('button', { class: 'btn live', type: 'button', onclick: () => openOutput() }, '出力ウィンドウ'),
  ),
  h('main', { class: 'ctl' },
    h('div', { class: 'stage' },
      gl,
      h('div', { class: 'pgmwrap' }, pgmEl, h('div', { class: 'pgmbar' }, h('span', { class: 'air' }, 'PGM'), pgmState)),
      h('div', { class: 'deckrow' }, deckUi.A.el, takeCol, deckUi.B.el),
      h('div', { class: 'meta' },
        h('span', { class: 'keys' }, 'T take · X cut · 1–9 cue · esc black · Z freeze · S safe · SPACE tap · ←/→ nudge · ↑/↓ bpm · D downbeat · hold B build · ⏎ drop · O output'),
      ),
    ),
    h('aside', {},
      h('nav', { class: 'tabs' }, tabBtns.perform, tabBtns.studio),
      performEl,
      studio.el,
    ),
  ),
);

performEl.append(
  h('section', { class: 'box' },
    h('div', { class: 'row between' }, h('span', { class: 'lbl' }, 'Works → cue deck'), h('span', { class: 'note' }, 'ダブルクリックで即カット')),
    worksEl,
  ),
  h('section', { class: 'box' },
    h('div', { class: 'row between' }, macrosTitle,
      h('button', { class: 'btn', type: 'button', onclick: () => { engine.resetKnobs(editDeck); renderMacros(); } }, 'Reset')),
    macrosEl,
    presetsEl,
  ),
  h('section', { class: 'box' }, h('span', { class: 'lbl' }, 'Master FX'), fxEl),
  h('section', { class: 'box' },
    h('div', { class: 'row between' }, h('span', { class: 'lbl' }, 'Clock'), clockSrcEl),
    h('div', { class: 'row between' }, h('span', { class: 'row', style: 'align-items:flex-end' }, bpmEl, h('span', { class: 'lbl' }, 'BPM')), beatsEl),
    h('div', { class: 'row' },
      h('button', { class: 'btn wide', type: 'button', onclick: () => clock.tap() }, 'Tap'),
      h('button', { class: 'btn', type: 'button', 'aria-label': '位相を早める', onclick: () => clock.nudge(-10) }, '−'),
      h('button', { class: 'btn', type: 'button', 'aria-label': '位相を遅らせる', onclick: () => clock.nudge(10) }, '+'),
      h('button', { class: 'btn', type: 'button', onclick: () => clock.downbeat() }, '1'),
    ),
    h('div', { class: 'row' }, followBtn),
    h('div', { class: 'row' },
      h('button', {
        class: 'btn wide', type: 'button',
        onpointerdown: () => { choreo.building = true; },
        onpointerup: () => { choreo.building = false; },
        onpointerleave: () => { choreo.building = false; },
      }, 'Build (hold B)'),
      h('button', { class: 'btn live wide', type: 'button', onclick: () => choreo.fire() }, 'Drop ⏎'),
    ),
  ),
  h('section', { class: 'box' },
    h('span', { class: 'lbl' }, 'Audio'),
    h('div', { class: 'row' },
      h('button', { class: 'btn', type: 'button', onclick: () => void useMic() }, 'Mic'),
      h('button', { class: 'btn', type: 'button', onclick: () => void useTestTrack() }, 'Test track'),
      h('button', { class: 'btn', type: 'button', onclick: () => fileInput.click() }, 'File…'),
      h('button', { class: 'btn', type: 'button', onclick: () => { audio.stop(); tracker.reset(); } }, 'Off'),
      fileInput,
    ),
    audioLabel,
    ...meterNames.map((n, i) => h('div', { class: 'meter' }, h('span', { class: 'lbl' }, n), h('div', { class: 'bar' }, meterBars[i]))),
  ),
  h('section', { class: 'box' },
    h('span', { class: 'lbl' }, 'Output'),
    h('label', { class: 'macro' },
      h('span', { class: 'lbl' }, 'Exposure'),
      h('input', { type: 'range', min: 0.2, max: 3, step: 0.01, value: 1, oninput: (e: Event) => { engine.exposure = Number((e.target as HTMLInputElement).value); } }),
      h('span', {}),
    ),
    h('p', { class: 'note', style: 'margin:0' }, '出力ウィンドウを DELL のディスプレイへ移し、ダブルクリック（または F）で全画面にします。'),
  ),
  h('section', { class: 'box' }, h('span', { class: 'lbl' }, 'Errors'), errorsEl),
);

function showTab(tab: 'perform' | 'studio') {
  performEl.hidden = tab !== 'perform';
  studio.el.hidden = tab !== 'studio';
  tabBtns.perform.classList.toggle('on', tab === 'perform');
  tabBtns.studio.classList.toggle('on', tab === 'studio');
  try {
    localStorage.setItem('shiki.tab', tab);
  } catch {
    /* storage unavailable */
  }
}
let initialTab: string | null = null;
try {
  initialTab = localStorage.getItem('shiki.tab');
} catch {
  /* storage unavailable */
}
showTab(initialTab === 'studio' ? 'studio' : 'perform');

// ---------- decks, takes & panic ----------
const cueDeck = (): Deck => other(engine.onAir);

function loadInto(deck: Deck, w: InstrumentModule, keepKnobs = false): boolean {
  const ok = engine.load(deck, w, { keepKnobs });
  if (ok) {
    renderWorks();
    renderMacros();
    studio.refresh();
  }
  return ok;
}

function doTake(opts: Partial<typeof take> = {}) {
  if (engine.isSafe) {
    // Leaving safe: cut straight back to the on-air deck.
    engine.onAir = engine.onAir;
    return;
  }
  if (!engine.take({ ...take, ...opts })) pushError('take', `デッキ ${cueDeck()} に作品がありません`);
}

function goSafe() {
  if (!engine.safe()) pushError('safe', 'セーフ用の作品がありません');
}

function setEditDeck(deck: Deck) {
  editDeck = deck;
  renderMacros();
  studio.refresh();
}

// ---------- works & macros ----------
function renderWorks() {
  worksEl.replaceChildren(
    ...list.map((w, i) => {
      const id = w.manifest.id;
      const tags = DECKS.filter((d) => engine.workId(d) === id);
      return h('button', {
        class: `work${tags.includes(engine.onAir) ? ' on' : tags.length ? ' cue' : ''}`, type: 'button',
        onclick: () => loadInto(cueDeck(), w),
        ondblclick: () => { if (loadInto(cueDeck(), w)) doTake({ transition: 'cut', quantize: 'now' }); },
      },
        h('span', { class: 'k' }, String(i + 1)),
        h('span', { class: 'n' }, w.manifest.name),
        h('span', { class: 'j' }, w.manifest.nameJa ?? ''),
        h('span', { class: 'dtags' }, tags.join(' ')),
      );
    }),
  );
}

const effBars: HTMLElement[] = [];
function renderMacros() {
  const deck = editDeck;
  const m = engine.manifest(deck);
  const knobs = engine.knobs[deck];
  macrosTitle.textContent = `Macros · deck ${deck}${m ? ` · ${m.name}` : ''}`;
  effBars.length = 0;
  macrosEl.replaceChildren(
    ...(m?.macros ?? []).map((def, i) => {
      const value = h('span', { class: 'mono', style: 'font-size:11px;text-align:right' }, knobs[i].toFixed(2));
      const eff = h('i');
      effBars.push(eff);
      return h('label', { class: 'macro' },
        h('span', { class: 'lbl' }, def.label),
        h('input', {
          type: 'range', min: 0, max: 1, step: 0.001, value: knobs[i],
          oninput: (e: Event) => {
            knobs[i] = Number((e.target as HTMLInputElement).value);
            value.textContent = knobs[i].toFixed(2);
          },
        }),
        value,
        def.mod ? h('span', { class: 'mod' }, `${def.mod.source.toUpperCase()} +${def.mod.amount.toFixed(2)}`) : null,
        h('span', { class: 'eff' }, eff),
      );
    }),
  );
  presetsEl.replaceChildren(
    ...Object.keys(m?.presets ?? {}).map((name) =>
      h('button', { class: 'btn', type: 'button', onclick: () => { engine.applyPreset(deck, name); renderMacros(); } }, name),
    ),
  );
}

function find(id: string | null): InstrumentModule | undefined {
  return id ? list.find((x) => x.manifest.id === id) : undefined;
}

function applyWorks(res: LoadResult) {
  list = res.works;
  broken.clear();
  for (const e of res.errors) {
    broken.add(e.id);
    pushError(e.id, `読み込めません（ほかの作品は動き続けます）\n${e.error}`);
  }
  for (const deck of DECKS) {
    const w = find(engine.workId(deck));
    if (w) engine.load(deck, w, { keepKnobs: true });
  }
  const safe = find(engine.workId('safe'));
  if (safe) engine.setSafe(safe);
  renderWorks();
  renderMacros();
  studio.refresh();
}

onWorksChanged(applyWorks);

/**
 * Studio check after an agent finished: waits for the registry to hold the work's latest code (a new folder or
 * edited files arrive through HMR), then loads it fail-safe — into its deck, or for a new work into the cue deck
 * and cut on air. Returns the load/compile error, or null.
 */
async function verifyWork(id: string): Promise<string | null> {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const since = Date.now();
  await sleep(1500);
  for (let i = 0; i < 16 && !find(id); i++) await sleep(500);
  const w = find(id);
  if (!w) {
    const e = lastError.get(id);
    return e && e.at >= since - 120_000 ? e.msg : `works/${id} が作品一覧に現れません（manifest.id とフォルダ名が一致していない可能性）`;
  }
  const before = Date.now();
  const home = DECKS.find((d) => engine.workId(d) === id);
  const deck = home ?? cueDeck();
  if (loadInto(deck, w, home !== undefined)) {
    if (!home) {
      engine.onAir = deck;
      setEditDeck(deck);
    }
    return null;
  }
  const e = lastError.get(id);
  return e && e.at >= before ? e.msg : '読み込みに失敗しました（詳細なし）';
}

// ---------- audio & clock ----------
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

function toggleFollow() {
  clock.follow = !clock.follow;
  if (!clock.follow && clock.source === 'audio') clock.source = 'tap';
}

function openOutput() {
  window.open('/output.html', 'shiki-output', 'popup,width=1280,height=720');
}

// ---------- errors ----------
function pushError(work: string, msg: string) {
  console.warn(`[shiki] ${work}: ${msg}`);
  lastError.set(work, { at: Date.now(), msg });
  errors.unshift({ at: new Date().toLocaleTimeString(), work, msg });
  errors.length = Math.min(errors.length, 5);
  errorsEl.replaceChildren(
    ...errors.map((e) => h('div', { class: 'error' }, `${e.at} · ${e.work}\n${e.msg}`)),
  );
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
    default:
      if (/^[1-9]$/.test(e.key)) {
        const w = list[Number(e.key) - 1];
        if (w) loadInto(cueDeck(), w);
      }
  }
});

window.addEventListener('keyup', (e) => {
  if (e.key === 'b' || e.key === 'B') choreo.building = false;
});

// ---------- UI loop ----------
function ui() {
  requestAnimationFrame(ui);
  fpsEl.textContent = `${Math.round(engine.fps)} fps`;
  const alive = performance.now() - output.seen < 2500;
  outEl.textContent = alive ? `OUT · ${output.w}×${output.h} · ${output.fps} fps` : 'OUT · closed';
  const air = engine.manifest(engine.isSafe ? 'safe' : engine.onAir);
  nowName.textContent = air?.name ?? '—';
  nowJa.textContent = engine.isSafe ? 'SAFE' : air?.nameJa ?? '';

  // decks & take
  const active = engine.active;
  const pending = engine.pending;
  for (const d of DECKS) {
    const card = deckUi[d];
    const m = engine.manifest(d);
    card.name.textContent = m ? m.name : '— empty —';
    const onAir = !engine.isSafe && (d === engine.onAir || active?.to === d);
    card.el.classList.toggle('air', onAir);
    card.el.classList.toggle('edit', d === editDeck);
    card.state.textContent = d === engine.onAir ? (engine.isSafe ? 'standby' : 'on air') : active?.to === d ? 'taking' : 'cue';
  }
  if (document.activeElement !== fader) fader.value = String(engine.mix);
  if (pending) takeStatus.textContent = `${pending.transition} → ${pending.to} · in ${Math.max(0, pending.startBeat - latest.beats).toFixed(1)} beats`;
  else if (active) takeStatus.textContent = `${active.transition} → ${active.to} · ${Math.round(engine.progress * 100)}%`;
  else takeStatus.textContent = `cue ${cueDeck()} ← ${engine.manifest(cueDeck())?.name ?? 'empty'}`;
  takeBtn.classList.toggle('armed', !!pending);
  panic.black.classList.toggle('hot', engine.isBlackout);
  panic.freeze.classList.toggle('hot', engine.isFrozen);
  panic.safe.classList.toggle('hot', engine.isSafe);
  pgmState.textContent = [engine.isBlackout && 'BLACKOUT', engine.isFrozen && 'FROZEN', engine.isSafe && 'SAFE',
    active && `${active.transition} ${Math.round(engine.progress * 100)}%`].filter(Boolean).join(' · ');
  for (const btn of fxEl.querySelectorAll<HTMLButtonElement>('.fxbtn')) btn.classList.toggle('on', engine.fx[btn.dataset.fx as MasterFx].on);

  // clock & audio
  bpmEl.textContent = clock.bpm.toFixed(1);
  clockSrcEl.textContent = `${clock.source}${clock.follow ? ` · conf ${clock.confidence.toFixed(2)}` : ''}`;
  followBtn.classList.toggle('on', clock.follow);
  const beatIdx = Math.floor(latest.bar * 4) % 4;
  [...beatsEl.children].forEach((el, i) => {
    el.classList.toggle('on', i === beatIdx && latest.beat < 0.35);
    el.classList.toggle('one', i === 0);
  });
  audioLabel.textContent = audio.mode === 'off' ? '入力なし' : `${audio.mode} · ${audio.label}`;
  meterNames.forEach((n, i) => (meterBars[i].style.width = `${Math.round(latest[n] * 100)}%`));
  engine.macros[editDeck].forEach((v, i) => {
    const bar = effBars[i];
    if (bar) bar.style.width = `${Math.round(v * 100)}%`;
  });
}

// ---------- automation hooks (dev only) ----------
/** The program viewport of the last rendered frame as a JPEG data URL. Call right after a render. */
function grab(quality = 0.9): string {
  const k = gl.width / Math.max(1, gl.clientWidth);
  const r = rel(pgmEl);
  const w = Math.max(2, Math.round(r.w * k));
  const hh = Math.max(2, Math.round(r.h * k));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = hh;
  c.getContext('2d')!.drawImage(gl, Math.round(r.x * k), Math.round(r.y * k), w, hh, 0, 0, w, hh);
  return c.toDataURL('image/jpeg', quality);
}

/** Saves the next rendered program frame to .agents/snaps/<name>.jpg via the dev server. */
async function snap(name = 'snap', quality = 0.9): Promise<string> {
  const url = await new Promise<string>((done) => requestAnimationFrame(() => done(grab(quality))));
  const res = await fetch(`/__shiki/snap?name=${encodeURIComponent(name)}`, { method: 'POST', body: url });
  return ((await res.json()) as { file: string }).file;
}

/** Records `seconds` of the program to .agents/clips/<name>.mp4 (+ a contact sheet) via the dev server. */
async function record(name = 'clip', seconds = 8): Promise<{ mp4: string; sheet: string }> {
  const k = gl.width / Math.max(1, gl.clientWidth);
  const r = rel(pgmEl);
  const c = h('canvas', { width: Math.round(r.w * k), height: Math.round(r.h * k) });
  const ctx = c.getContext('2d')!;
  let on = true;
  const copy = () => {
    if (!on) return;
    requestAnimationFrame(copy);
    ctx.drawImage(gl, Math.round(r.x * k), Math.round(r.y * k), c.width, c.height, 0, 0, c.width, c.height);
  };
  copy();
  const stream = c.captureStream(30);
  const rec = new MediaRecorder(stream, { mimeType: 'video/webm;codecs=vp9', videoBitsPerSecond: 16_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => chunks.push(e.data);
  const stopped = new Promise<void>((done) => (rec.onstop = () => done()));
  rec.start(250);
  await new Promise((res) => setTimeout(res, seconds * 1000));
  rec.stop();
  await stopped;
  on = false;
  stream.getTracks().forEach((t) => t.stop());
  const res = await fetch(`/__shiki/clip?name=${encodeURIComponent(name)}`, {
    method: 'POST',
    body: new Blob(chunks, { type: 'video/webm' }),
  });
  return (await res.json()) as { mp4: string; sheet: string };
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
        engine.take({ ...take }, scripted.beats);
      }
      engine.renderAt(frameTime);
      await fetch(`/__shiki/frame?name=${encodeURIComponent(name)}&i=${i}`, { method: 'POST', body: grab(0.9) });
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
      engine, clock, audio, tracker, choreo, snap, record, offline, take,
      /** Puts a work straight on air (automation). */
      select: (id: string) => {
        const w = find(id);
        if (w && loadInto(engine.onAir, w)) setEditDeck(engine.onAir);
        return engine.workId(engine.onAir);
      },
      cue: (id: string) => { const w = find(id); if (w) loadInto(cueDeck(), w); return engine.workId(cueDeck()); },
      doTake,
      setKnob: (id: string, v: number) => {
        const i = engine.manifest(editDeck)?.macros.findIndex((m) => m.id === id) ?? -1;
        if (i >= 0) { engine.knobs[editDeck][i] = v; renderMacros(); }
      },
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
list = initial.works;
const first = find('moonsea') ?? list[0];
const second = find('ink-tide') ?? list.find((w) => w !== first) ?? first;
if (first) {
  engine.load('A', first);
  engine.setSafe(first);
}
if (second) engine.load('B', second);
renderWorks();
renderMacros();
studio.refresh();
engine.start();
ui();
