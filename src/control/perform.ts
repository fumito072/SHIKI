// Perform screen — the Immersive design (design/concepts/perform-c-immersive.jpg, canvas "PerformImmersive"): the
// master output fills the window and every control floats above it on dark glass. Deck previews are holes in the glass
// that the GPU canvas draws into.
import { h } from './dom';
import { knob } from './knob';
import type { Knob } from './knob';
import type { DeckEngine, Deck, MasterFx, Quantize, Rect, Transition } from '../engine/DeckEngine';
import type { InstrumentModule, LiveSignals } from '../engine/types';

export interface TakeOpts {
  transition: Transition;
  beats: number;
  quantize: Quantize;
}

export interface PerformCtx {
  engine: DeckEngine;
  signals(): LiveSignals;
  works(): InstrumentModule[];
  art(id: string): string | undefined;
  editDeck(): Deck;
  setEditDeck(d: Deck): void;
  cueDeck(): Deck;
  loadInto(deck: Deck, w: InstrumentModule): boolean;
  take(opts?: Partial<TakeOpts>): void;
  takeOpts: TakeOpts;
  goSafe(): void;
  openOutput(): void;
  build(on: boolean): void;
  drop(): void;
  audio: { mode(): string; label(): string; mic(): void; test(): void; file(): void; off(): void };
  /** AI prompt bar: feedback to the work on the cue deck. */
  quickFeedback(text: string, status: (s: string, kind?: 'run' | 'ok' | 'err') => void): Promise<void>;
}

const TRANSITIONS: { id: Transition; label: string }[] = [
  { id: 'dissolve', label: 'DISSOLVE' }, { id: 'luma-wipe', label: 'LUMA WIPE' }, { id: 'feedback-melt', label: 'FEEDBACK MELT' },
  { id: 'displace', label: 'DISPLACE' }, { id: 'cut', label: 'CUT' },
];
const QUANTIZE: { id: Quantize; label: string }[] = [
  { id: 'now', label: 'Now' }, { id: 'beat', label: 'Beat' }, { id: 'bar', label: 'Bar' },
  { id: 'phrase16', label: '16' }, { id: 'phrase32', label: '32' },
];
const FX: { id: MasterFx; label: string }[] = [
  { id: 'feedback', label: 'Trails' }, { id: 'kaleido', label: 'Kaleido' }, { id: 'rgb-split', label: 'RGB split' },
  { id: 'grain', label: 'Grain' }, { id: 'strobe', label: 'Strobe' },
];
const METERS = [
  { key: 'low', label: 'Low' }, { key: 'mid', label: 'Mid' }, { key: 'high', label: 'High' },
  { key: 'kick', label: 'Kick' }, { key: 'tension', label: 'Tens' }, { key: 'drop', label: 'Drop' },
] as const;

const ICON = {
  out: '<svg class="ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="2" y="4" width="16" height="10" rx="1"/><path d="M7 17h6M10 14v3"/></svg>',
  ai: '<svg viewBox="0 0 24 24" style="width:22px;height:22px;flex:none" fill="currentColor"><circle cx="12" cy="3.5" r="1.4"/><circle cx="18" cy="6" r="1.1"/><circle cx="20.5" cy="12" r="1.4"/><circle cx="18" cy="18" r="1.1"/><circle cx="12" cy="20.5" r="1.4"/><circle cx="6" cy="18" r="1.1"/><circle cx="3.5" cy="12" r="1.4"/><circle cx="6" cy="6" r="1.1"/><circle cx="12" cy="12" r="2" style="fill:var(--acc)"/></svg>',
  send: '<svg class="ico" viewBox="0 0 16 16" fill="currentColor"><path d="M2 2.5l12 5.5-12 5.5 2.2-5.5z"/></svg>',
  black: '<svg class="ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3"><rect x="3" y="4" width="14" height="12" rx="1"/><path d="M3 10h14v5a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" fill="currentColor"/></svg>',
  freeze: '<svg class="ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M10 2v16M3 6l14 8M3 14l14-8"/></svg>',
  safe: '<svg class="ico" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.3"><path d="M10 2.5l6 2.2v5c0 3.8-2.6 6.4-6 7.8-3.4-1.4-6-4-6-7.8v-5z"/></svg>',
};

export const svgEl = (html: string): HTMLElement => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};

/** A vertical segmented meter with a slowly falling peak mark. */
function meter(height = 96) {
  const fill = h('i');
  const peak = h('b');
  const el = h('div', { class: 'vm live', style: `--h:${height}px` }, fill, peak);
  let pk = 0;
  return {
    el,
    set(v: number, dt: number) {
      const x = Math.min(1, Math.max(0, v));
      pk = Math.max(x, pk - dt * 0.35);
      fill.style.height = `${Math.round(x * 100)}%`;
      peak.style.bottom = `${Math.round(pk * 100)}%`;
    },
  };
}

export function mountPerform(ctx: PerformCtx) {
  const { engine } = ctx;

  // ---------- decks ----------
  function deckPanel(deck: Deck) {
    const state = h('span', { class: 'onair' });
    const under = h('div', { class: 'under' });
    const hole = h('div', { class: 'screen hole scan' });
    const vms = [meter(118), meter(118)];
    const name = h('strong', { class: 'name', style: 'font-size:13px' });
    const tag = h('span', { class: 'lbl', style: 'font-size:9px' });
    const ja = h('span', { class: 'jp2', style: 'font-size:15px;color:#d6d1c6' });
    const el = h('section', { class: 'glass deck', 'aria-label': `デッキ${deck}`, onclick: () => ctx.setEditDeck(deck) },
      h('div', { class: 'dh' }, h('span', { class: 'dl' }, deck), h('span', { class: 'lbl', style: 'color:#d6d1c6' }, `Deck ${deck}`), state),
      under,
      h('div', { class: 'dk' }, hole, h('div', { class: 'vms' }, vms[0].el, vms[1].el)),
      h('div', { class: 'ph', style: 'align-items:flex-end' },
        h('span', { class: 'stack2', style: 'gap:2px' }, name, tag),
        ja,
      ),
    );
    return { el, state, under, hole, vms, name, tag, ja, hx: '' };
  }
  const decks = { A: deckPanel('A'), B: deckPanel('B') };

  // ---------- master title ----------
  const mtName = h('div', { class: 'mt-name name' });
  const mtJa = h('div', { class: 'jp2 mt-ja' });
  const mtState = h('div', { class: 'mt-state mono' });
  const mtitle = h('div', { class: 'mtitle', 'aria-hidden': 'true' },
    h('div', { class: 'mt' }, 'MASTER'),
    h('div', { class: 'lbl', style: 'letter-spacing:.42em;color:#d6d1c6' }, 'Live visual output'),
    h('i', { class: 'rule' }),
    mtName, mtJa, mtState,
  );

  // ---------- audio ----------
  const meters = METERS.map((m) => ({ ...m, m: meter(96) }));
  const srcBtns = {
    mic: h('button', { type: 'button', onclick: () => ctx.audio.mic() }, 'Mic'),
    file: h('button', { type: 'button', onclick: () => ctx.audio.test() }, 'Test'),
    pick: h('button', { type: 'button', onclick: () => ctx.audio.file() }, 'File…'),
    off: h('button', { type: 'button', onclick: () => ctx.audio.off() }, 'Off'),
  };
  const audioLabel = h('span', { class: 'mono a-src' });
  const audio = h('section', { class: 'glass audio', 'aria-label': 'オーディオ' },
    h('div', { class: 'ph' }, h('span', { class: 'lbl', style: 'color:#ece6da' }, 'Audio'), audioLabel),
    h('div', { class: 'meters' },
      ...meters.map((m) => h('div', { class: 'stack2', style: 'align-items:center;gap:6px' }, h('span', { class: 'lbl', style: 'font-size:9px' }, m.label), m.m.el)),
    ),
    h('div', { class: 'pq', role: 'group', 'aria-label': '音の入力' }, srcBtns.mic, srcBtns.file, srcBtns.pick, srcBtns.off),
    h('div', { class: 'bd2' },
      h('button', {
        type: 'button', class: 'btn',
        onpointerdown: () => ctx.build(true), onpointerup: () => ctx.build(false), onpointerleave: () => ctx.build(false),
      }, 'Build · hold B'),
      h('button', { type: 'button', class: 'btn live', onclick: () => ctx.drop() }, 'Drop ⏎'),
    ),
  );

  // ---------- library ----------
  const lgrid = h('div', { class: 'lgrid' });
  const libNext = h('span', { class: 'jp2', style: 'font-size:12px;color:#d6d1c6' });
  const library = h('section', { class: 'glass lib', 'aria-label': 'ライブラリ' },
    h('div', { class: 'ph' },
      h('span', { style: 'display:flex;gap:10px;align-items:baseline' }, h('span', { class: 'lbl', style: 'color:#ece6da' }, 'Library'), h('span', { style: 'font-size:11px;color:#a3a8a2' }, 'ライブラリ')),
      libNext,
    ),
    lgrid,
  );
  const thumbs = new Map<string, { el: HTMLElement; img: HTMLImageElement; dots: HTMLElement[]; badge: HTMLElement }>();

  function renderLibrary() {
    thumbs.clear();
    lgrid.replaceChildren(
      ...ctx.works().map((w, i) => {
        const m = w.manifest;
        const img = h('img', { alt: m.name, draggable: false });
        const art = ctx.art(m.id);
        if (art) img.src = art;
        const dots = Array.from({ length: 10 }, () => h('i'));
        const badge = h('span', { class: 'chip badge', hidden: true }, 'Next');
        const el = h('article', {
          class: 'lit', title: `${i + 1}: ${m.name} — クリックでキュー、ダブルクリックで即カット`,
          onclick: () => ctx.loadInto(ctx.cueDeck(), w),
          ondblclick: () => { if (ctx.loadInto(ctx.cueDeck(), w)) ctx.take({ transition: 'cut', quantize: 'now' }); },
        },
          h('div', { class: 'screen scan' }, img, h('span', { class: 'lk mono' }, String(i + 1))),
          badge,
          h('strong', { class: 'name', style: 'font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis' }, m.name),
          h('span', { class: 'ph' }, h('span', { class: 'lbl', style: 'font-size:8.5px' }, m.mood.slice(0, 2).join(' · ')), h('span', { class: 'edots' }, ...dots)),
        );
        dots.forEach((d, k) => {
          const x = (k + 0.5) / 10;
          if (x >= m.energy[0] && x <= m.energy[1]) d.classList.add('in');
        });
        thumbs.set(m.id, { el, img, dots, badge });
        return el;
      }),
    );
  }

  /** Library thumbnail for works without a key visual, grabbed from their deck preview. */
  function setThumb(id: string, url: string) {
    const t = thumbs.get(id);
    if (t && !t.img.getAttribute('src')) t.img.src = url;
  }
  const hasThumb = (id: string) => !!thumbs.get(id)?.img.getAttribute('src');

  // ---------- transition ----------
  const qBtns = QUANTIZE.map((q) => {
    const b = h('button', { type: 'button', title: q.id.startsWith('phrase') ? `${q.label} 小節の頭` : q.label, onclick: () => { ctx.takeOpts.quantize = q.id; paintQ(); } }, q.label);
    b.dataset.q = q.id;
    return b;
  });
  const paintQ = () => qBtns.forEach((b) => b.classList.toggle('on', b.dataset.q === ctx.takeOpts.quantize));
  paintQ();
  const fader = h('input', {
    class: 'rng xf', type: 'range', min: 0, max: 1, step: 0.001, value: 0, 'aria-label': 'クロスフェーダー',
    oninput: () => { engine.mix = Number(fader.value); },
  });
  const takeInfo = h('span', { class: 'mono', style: 'font-size:10px;color:#a3a8a2' });
  const takeBtn = h('button', { type: 'button', class: 'btn live take', onclick: () => ctx.take() }, 'Take');
  const mix = h('section', { class: 'glass mix', 'aria-label': 'トランジション' },
    h('div', { class: 'ph2' },
      h('label', { class: 'stack2', style: 'gap:4px' }, h('span', { class: 'lbl' }, 'Transition ', h('span', { style: 'letter-spacing:0' }, 'トランジション')),
        h('select', { class: 'sel', onchange: (e: Event) => { ctx.takeOpts.transition = (e.target as HTMLSelectElement).value as Transition; } },
          ...TRANSITIONS.map((t) => h('option', { value: t.id, selected: t.id === ctx.takeOpts.transition }, t.label)))),
      h('label', { class: 'stack2', style: 'gap:4px' }, h('span', { class: 'lbl' }, 'Beats'),
        h('select', { class: 'sel', onchange: (e: Event) => { ctx.takeOpts.beats = Number((e.target as HTMLSelectElement).value); } },
          ...[1, 2, 4, 8, 16, 32].map((b) => h('option', { value: b, selected: b === ctx.takeOpts.beats }, String(b))))),
    ),
    h('div', { class: 'stack2', style: 'gap:4px' }, h('span', { class: 'lbl' }, 'Quantize ', h('span', { style: 'letter-spacing:0' }, '切替の頭（小節）')), h('div', { class: 'pq', role: 'group' }, ...qBtns)),
    h('div', { class: 'xfrow' },
      h('span', { class: 'name xa', style: 'font-size:15px;font-weight:300' }, 'A'),
      h('div', { class: 'stack2', style: 'gap:2px' }, fader, h('div', { class: 'ruler' })),
      h('span', { class: 'name xb', style: 'font-size:15px;font-weight:300' }, 'B'),
    ),
    h('div', { class: 'ph' }, takeInfo, takeBtn),
  );

  // ---------- macros ----------
  const kgrid = h('div', { class: 'kgrid' });
  const presets = h('div', { class: 'pq presets' });
  const macroWork = h('span', { class: 'mono', style: 'font-size:10.5px;letter-spacing:.08em' });
  const macroDeck = { A: h('button', { type: 'button', onclick: () => ctx.setEditDeck('A') }, 'A'), B: h('button', { type: 'button', onclick: () => ctx.setEditDeck('B') }, 'B') };
  const macro = h('section', { class: 'glass', 'aria-label': 'マクロ' },
    h('div', { class: 'ph' },
      h('span', { style: 'display:flex;gap:8px;align-items:baseline' }, h('span', { class: 'lbl', style: 'color:#ece6da' }, 'Macro'), h('span', { style: 'font-size:11px;color:#a3a8a2' }, 'マクロ')),
      h('span', { style: 'display:flex;gap:8px;align-items:center' }, macroWork, h('span', { class: 'pq mini' }, macroDeck.A, macroDeck.B)),
    ),
    kgrid,
    presets,
  );
  let macroKnobs: Knob[] = [];

  function renderMacros() {
    const deck = ctx.editDeck();
    const m = engine.manifest(deck);
    const knobs = engine.knobs[deck];
    macroWork.textContent = m ? m.name : '—';
    macroDeck.A.classList.toggle('on', deck === 'A');
    macroDeck.B.classList.toggle('on', deck === 'B');
    macroKnobs = (m?.macros ?? []).map((def, i) =>
      knob({ label: def.label, value: knobs[i], reset: def.default, live: deck === engine.onAir, onInput: (v) => { knobs[i] = v; } }),
    );
    kgrid.replaceChildren(...macroKnobs.map((k) => k.el));
    presets.replaceChildren(
      ...Object.keys(m?.presets ?? {}).map((name) =>
        h('button', { type: 'button', onclick: () => { engine.applyPreset(deck, name); renderMacros(); } }, name)),
      h('button', { type: 'button', onclick: () => { engine.resetKnobs(deck); renderMacros(); } }, 'Reset'),
    );
  }

  // ---------- FX ----------
  const fxTogs = new Map<MasterFx, HTMLButtonElement>();
  const fx = h('section', { class: 'glass', 'aria-label': 'エフェクト' },
    h('div', { class: 'ph' }, h('span', { style: 'display:flex;gap:8px;align-items:baseline' }, h('span', { class: 'lbl', style: 'color:#ece6da' }, 'FX'), h('span', { style: 'font-size:11px;color:#a3a8a2' }, 'エフェクト'))),
    h('div', { class: 'fxg' },
      ...FX.map(({ id, label }) => {
        const tog = h('button', { type: 'button', class: 'tog off', onclick: () => engine.setFx(id, { on: !engine.fx[id].on }) }, 'OFF');
        fxTogs.set(id, tog);
        const k = knob({ label, value: engine.fx[id].amount, size: 38, onInput: (v) => engine.setFx(id, { amount: v }) });
        return h('div', { class: 'fxc' }, k.el, tog);
      }),
      h('div', { class: 'fxc' },
        knob({ label: 'Exposure', value: (1 - 0.2) / 2.8, size: 38, onInput: (v) => { engine.exposure = 0.2 + v * 2.8; } }).el,
        h('span', { class: 'mono', style: 'font-size:9px;color:#a3a8a2;height:28px;display:flex;align-items:center' }, 'master'),
      ),
    ),
  );

  // ---------- AI prompt & emergency ----------
  const aiInput = h('input', { type: 'text', placeholder: 'キックで奥にズームして', 'aria-label': 'AIへの指示（キューのデッキの作品を直します）' });
  const aiTarget = h('span', { class: 'mono', style: 'font-size:10.5px;flex:none;color:var(--cue)' });
  const aiStatus = h('span', { class: 'ai-st mono' });
  const aiSend = async () => {
    const text = aiInput.value.trim();
    if (!text) return;
    aiInput.value = '';
    await ctx.quickFeedback(text, (s, kind) => {
      aiStatus.textContent = s;
      aiStatus.className = `ai-st mono ${kind ?? ''}`;
    });
  };
  aiInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' && !e.isComposing) void aiSend();
  });
  aiInput.addEventListener('keyup', (e) => e.stopPropagation());
  const sendBtn = h('button', { type: 'button', class: 'icobtn send', 'aria-label': '送る', onclick: () => void aiSend() });
  sendBtn.append(svgEl(ICON.send));
  const ai = h('section', { class: 'glass ai', 'aria-label': 'AIプロンプト' },
    svgEl(ICON.ai),
    h('span', { class: 'stack2', style: 'gap:1px;flex:none' }, h('span', { class: 'lbl', style: 'font-size:9px' }, 'AI prompt'), h('span', { style: 'font-size:10px;color:#a3a8a2' }, 'AIプロンプト')),
    h('div', { class: 'ai-in' }, aiInput, aiStatus),
    aiTarget,
    sendBtn,
  );

  const ebtn = (icon: string, en: string, ja: string, onclick: () => void) =>
    h('button', { type: 'button', class: 'ebtn', onclick }, svgEl(icon), h('span', { class: 'stack2', style: 'gap:0' }, h('span', { class: 'mono' }, en), h('span', { class: 'jp' }, ja)));
  const emg = {
    black: ebtn(ICON.black, 'BLACKOUT', 'ブラックアウト · esc', () => engine.blackout(!engine.isBlackout)),
    freeze: ebtn(ICON.freeze, 'FREEZE', 'フリーズ · Z', () => engine.freeze(!engine.isFrozen)),
    safe: ebtn(ICON.safe, 'SAFE', 'セーフ · S', () => ctx.goSafe()),
    out: ebtn(ICON.out, 'OUTPUT', '出力ウィンドウ · O', () => ctx.openOutput()),
  };
  const emergency = h('section', { class: 'glass emg', 'aria-label': '緊急操作' }, emg.black, emg.freeze, emg.safe, emg.out);

  // ---------- layout ----------
  const el = h('div', { class: 'ui perform' },
    decks.A.el, mtitle, decks.B.el, audio,
    h('div', { class: 'bottom' }, library, mix, macro, fx),
    h('div', { class: 'last' }, ai, emergency),
  );
  decks.A.el.style.cssText = 'grid-column:1;grid-row:1';
  decks.B.el.style.cssText = 'grid-column:3;grid-row:1';

  // ---------- per frame ----------
  let last = performance.now();
  function frame() {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    const s = ctx.signals();
    const active = engine.active;
    const pending = engine.pending;
    const safe = engine.isSafe;

    for (const d of ['A', 'B'] as const) {
      const p = decks[d];
      const m = engine.manifest(d);
      const onAir = !safe && (d === engine.onAir || active?.to === d);
      p.state.textContent = d === engine.onAir ? (safe ? 'STANDBY' : 'ON AIR') : active?.to === d ? 'TAKING' : 'CUE';
      p.state.className = onAir ? 'onair' : 'oncue';
      p.under.className = onAir ? 'under' : 'under cue';
      p.hole.classList.toggle('air-out', onAir);
      p.hole.classList.toggle('cue-out', !onAir);
      p.el.classList.toggle('edit', d === ctx.editDeck());
      p.name.textContent = m?.name ?? '— empty —';
      p.tag.textContent = m ? m.mood.slice(0, 2).join(' · ') : 'クリックした作品が入ります';
      p.ja.textContent = m?.nameJa ?? '';
      const share = d === 'A' ? 1 - engine.mix : engine.mix;
      p.vms[0].set(share, dt);
      p.vms[1].set(engine.macros[d][0] ?? 0, dt);
      // Cut the glass where the GPU draws the deck preview.
      const hx = `${p.hole.offsetLeft},${p.hole.offsetTop},${p.hole.offsetWidth},${p.hole.offsetHeight}`;
      if (hx !== p.hx) {
        p.hx = hx;
        p.el.style.setProperty('--hx', `${p.hole.offsetLeft}px`);
        p.el.style.setProperty('--hy', `${p.hole.offsetTop}px`);
        p.el.style.setProperty('--hw', `${p.hole.offsetWidth}px`);
        p.el.style.setProperty('--hh', `${p.hole.offsetHeight}px`);
      }
    }

    const air = engine.manifest(safe ? 'safe' : engine.onAir);
    mtName.textContent = air?.name ?? '';
    mtJa.textContent = air?.nameJa ?? '';
    mtState.textContent = [engine.isBlackout && 'BLACKOUT', engine.isFrozen && 'FROZEN', safe && 'SAFE',
      active && `${active.transition} → ${active.to} ${Math.round(engine.progress * 100)}%`].filter(Boolean).join(' · ');

    for (const m of meters) m.m.set(s[m.key], dt);
    const mode = ctx.audio.mode();
    audioLabel.textContent = mode === 'off' ? '入力なし' : ctx.audio.label();
    srcBtns.mic.classList.toggle('on', mode === 'mic');
    srcBtns.file.classList.toggle('on', mode === 'file');
    srcBtns.off.classList.toggle('on', mode === 'off');

    // library state + a simple "next" hint: works whose energy band contains the room's energy right now
    const energy = Math.min(1, s.level * 0.6 + s.low * 0.4);
    const onDecks = new Set([engine.workId('A'), engine.workId('B')]);
    const nexts: string[] = [];
    for (const w of ctx.works()) {
      const id = w.manifest.id;
      const t = thumbs.get(id);
      if (!t) continue;
      const isAir = !safe && engine.workId(engine.onAir) === id;
      t.el.classList.toggle('air', isAir);
      t.el.classList.toggle('cue', !isAir && onDecks.has(id));
      t.dots.forEach((d, k) => d.classList.toggle('now', d.classList.contains('in') && Math.abs((k + 0.5) / 10 - energy) < 0.05));
      const fits = !onDecks.has(id) && energy >= w.manifest.energy[0] && energy <= w.manifest.energy[1] && nexts.length < 2;
      t.badge.hidden = !fits;
      if (fits) nexts.push(w.manifest.name);
    }
    libNext.textContent = nexts.length ? `今の音に合う → ${nexts.join(' · ')}` : '';

    // transition
    if (document.activeElement !== fader) fader.value = String(engine.mix);
    const cue = ctx.cueDeck();
    takeBtn.textContent = `Take → ${cue}`;
    takeBtn.classList.toggle('armed', !!pending);
    if (pending) takeInfo.textContent = `${pending.transition} → ${pending.to} · あと ${Math.max(0, pending.startBeat - s.beats).toFixed(1)} 拍`;
    else if (active) takeInfo.textContent = `${active.transition} → ${active.to} · ${Math.round(engine.progress * 100)}%`;
    else takeInfo.textContent = `キュー ${cue} · ${engine.manifest(cue)?.name ?? '空'}`;

    // macros & fx
    engine.macros[ctx.editDeck()].forEach((v, i) => macroKnobs[i]?.setEffective(v));
    for (const [id, tog] of fxTogs) {
      const on = engine.fx[id].on;
      tog.classList.toggle('off', !on);
      tog.textContent = on ? 'ON' : 'OFF';
    }
    emg.black.classList.toggle('hot', engine.isBlackout);
    emg.freeze.classList.toggle('hot', engine.isFrozen);
    emg.safe.classList.toggle('hot', safe);
    aiTarget.textContent = `→ DECK ${cue}`;
  }

  /** Viewports the GPU draws the deck previews into (CSS px relative to the canvas). */
  function holes(rel: (el: HTMLElement) => Rect): Partial<Record<Deck, Rect>> {
    return { A: rel(decks.A.hole), B: rel(decks.B.hole) };
  }

  return {
    el, frame, renderLibrary, renderMacros, setThumb, hasThumb, holes,
    toggleTitle: () => mtitle.classList.toggle('off'),
  };
}
