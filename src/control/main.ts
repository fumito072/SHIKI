import './control.css';
import { Engine } from '../engine/Engine';
import { Clock } from '../engine/Clock';
import { AudioEngine } from '../audio/AudioEngine';
import { BeatTracker } from '../audio/BeatTracker';
import { openBridge } from '../bridge';
import { onWorksChanged, works } from '../works/registry';
import { SILENT } from '../engine/types';
import type { InstrumentModule, LiveSignals } from '../engine/types';

const TEST_TRACK = '/test/testtrack-128.wav';

// ---------- tiny DOM helper ----------
type Child = Node | string | null | undefined | false;
function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Record<string, unknown> = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v as EventListener);
    else if (k === 'class') el.className = String(v);
    else if (k in el) (el as unknown as Record<string, unknown>)[k] = v;
    else el.setAttribute(k, String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

// ---------- state ----------
let list: InstrumentModule[] = works;
const clock = new Clock();
const audio = new AudioEngine();
const tracker = new BeatTracker();
let latest: LiveSignals = { ...SILENT };
let lastNow = performance.now();
let output = { seen: 0, fps: 0, w: 0, h: 0 };
const errors: { at: string; work: string; msg: string }[] = [];

const bridge = openBridge((m) => {
  if (m.t === 'alive') output = { seen: performance.now(), fps: m.fps, w: m.width, h: m.height };
});

const preview = h('canvas', { class: 'preview' });
const engine = new Engine({
  canvas: preview,
  maxPixelRatio: 1.5,
  onError: (msg, work) => pushError(work, msg),
  onLoad: () => {
    renderWorks();
    renderMacros();
  },
});

engine.signals = (now) => {
  const dt = Math.min(0.1, Math.max(0.001, (now - lastNow) / 1000));
  lastNow = now;
  const a = audio.read(dt);
  if (audio.mode !== 'off') tracker.push(a.flux, now);
  clock.followAudio(tracker.estimate(), now);
  const c = clock.state(now);
  latest = {
    bpm: c.bpm, beat: c.beat, bar: c.bar, beats: c.beats,
    low: a.low, mid: a.mid, high: a.high, level: a.level, onset: a.onset, kick: a.kick,
  };
  bridge.send({ t: 'state', workId: engine.workId, knobs: Array.from(engine.knobs), signals: latest, exposure: engine.exposure });
  return latest;
};

// ---------- layout ----------
const nowName = h('span', { class: 'name' });
const nowJa = h('span', { class: 'jp2' });
const fpsEl = h('span', { class: 'lbl' });
const outEl = h('span', { class: 'lbl' });
const worksEl = h('div', { class: 'works' });
const macrosEl = h('div', { class: 'col', style: 'display:flex;flex-direction:column;gap:12px' });
const presetsEl = h('div', { class: 'row' });
const bpmEl = h('span', { class: 'num bpm' });
const clockSrcEl = h('span', { class: 'lbl' });
const beatsEl = h('div', { class: 'beats' }, h('i'), h('i'), h('i'), h('i'));
const followBtn = h('button', { class: 'btn', type: 'button', onclick: () => toggleFollow() }, 'Audio follow');
const audioLabel = h('span', { class: 'note' });
const meterNames = ['low', 'mid', 'high', 'onset', 'kick'] as const;
const meterBars = meterNames.map(() => h('i'));
const errorsEl = h('div', { class: 'errors' });
const fileInput = h('input', { type: 'file', accept: 'audio/*', style: 'display:none', onchange: () => void pickFile() });

const app = document.getElementById('app')!;
app.append(
  h('header', { class: 'top' },
    h('span', { class: 'wm' }, 'SHIKI'),
    h('span', { class: 'lbl' }, 'Step 1 · dev control'),
    h('span', { class: 'now' }, h('span', { class: 'air' }, 'ON AIR'), nowName, nowJa),
    h('span', { class: 'spacer' }),
    fpsEl,
    outEl,
    h('button', { class: 'btn live', type: 'button', onclick: () => openOutput() }, '出力ウィンドウ'),
  ),
  h('main', { class: 'ctl' },
    h('div', { class: 'stage' },
      preview,
      h('div', { class: 'meta' },
        h('span', { class: 'keys' }, 'SPACE tap · ←/→ nudge · ↑/↓ bpm · D downbeat · 1–9 work · O output'),
      ),
    ),
    h('aside', {},
      h('section', { class: 'box' }, h('span', { class: 'lbl' }, 'Works'), worksEl),
      h('section', { class: 'box' },
        h('div', { class: 'row between' }, h('span', { class: 'lbl' }, 'Macros'),
          h('button', { class: 'btn', type: 'button', onclick: () => { engine.resetKnobs(); renderMacros(); } }, 'Reset')),
        macrosEl,
        presetsEl,
      ),
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
    ),
  ),
);

// ---------- works & macros ----------
function selectWork(w: InstrumentModule) {
  if (engine.load(w)) {
    renderWorks();
    renderMacros();
  }
}

function renderWorks() {
  const id = engine.workId;
  const m = engine.manifest;
  nowName.textContent = m?.name ?? '—';
  nowJa.textContent = m?.nameJa ?? '';
  worksEl.replaceChildren(
    ...list.map((w, i) =>
      h('button', { class: `work${w.manifest.id === id ? ' on' : ''}`, type: 'button', onclick: () => selectWork(w) },
        h('span', { class: 'k' }, String(i + 1)),
        h('span', { class: 'n' }, w.manifest.name),
        h('span', { class: 'j' }, w.manifest.nameJa ?? ''),
      ),
    ),
  );
}

const effBars: HTMLElement[] = [];
function renderMacros() {
  const m = engine.manifest;
  effBars.length = 0;
  macrosEl.replaceChildren(
    ...(m?.macros ?? []).map((def, i) => {
      const value = h('span', { class: 'mono', style: 'font-size:11px;text-align:right' }, engine.knobs[i].toFixed(2));
      const eff = h('i');
      effBars.push(eff);
      return h('label', { class: 'macro' },
        h('span', { class: 'lbl' }, def.label),
        h('input', {
          type: 'range', min: 0, max: 1, step: 0.001, value: engine.knobs[i],
          oninput: (e: Event) => {
            engine.knobs[i] = Number((e.target as HTMLInputElement).value);
            value.textContent = engine.knobs[i].toFixed(2);
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
      h('button', { class: 'btn', type: 'button', onclick: () => { engine.applyPreset(name); renderMacros(); } }, name),
    ),
  );
}

onWorksChanged((fresh) => {
  list = fresh;
  const w = fresh.find((x) => x.manifest.id === engine.workId) ?? fresh[0];
  if (w) engine.load(w);
  renderWorks();
  renderMacros();
});

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
  errors.unshift({ at: new Date().toLocaleTimeString(), work, msg });
  errors.length = Math.min(errors.length, 5);
  errorsEl.replaceChildren(
    ...errors.map((e) => h('div', { class: 'error' }, `${e.at} · ${e.work}\n${e.msg}`)),
  );
}

// ---------- keys ----------
window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement | null;
  if (t && t.tagName === 'INPUT' && (t as HTMLInputElement).type !== 'range') return;
  const big = e.shiftKey;
  switch (e.key) {
    case ' ': e.preventDefault(); clock.tap(); break;
    case 'ArrowLeft': e.preventDefault(); clock.nudge(big ? -40 : -10); break;
    case 'ArrowRight': e.preventDefault(); clock.nudge(big ? 40 : 10); break;
    case 'ArrowUp': e.preventDefault(); clock.setBpm(clock.bpm + (big ? 5 : 0.5)); break;
    case 'ArrowDown': e.preventDefault(); clock.setBpm(clock.bpm - (big ? 5 : 0.5)); break;
    case 'd': case 'D': clock.downbeat(); break;
    case 'o': case 'O': openOutput(); break;
    default:
      if (/^[1-9]$/.test(e.key)) {
        const w = list[Number(e.key) - 1];
        if (w) selectWork(w);
      }
  }
});

// ---------- UI loop ----------
function ui() {
  requestAnimationFrame(ui);
  fpsEl.textContent = `${Math.round(engine.fps)} fps`;
  const alive = performance.now() - output.seen < 2500;
  outEl.textContent = alive ? `OUT · ${output.w}×${output.h} · ${output.fps} fps` : 'OUT · closed';
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
  engine.macros.forEach((v, i) => {
    const bar = effBars[i];
    if (bar) bar.style.width = `${Math.round(v * 100)}%`;
  });
}

// ---------- automation hooks (dev only) ----------
/** Saves the next rendered preview frame to .agents/snaps/<name>.jpg via the dev server. */
async function snap(name = 'snap', quality = 0.9): Promise<string> {
  const url = await new Promise<string>((done) =>
    requestAnimationFrame(() => done(preview.toDataURL('image/jpeg', quality))),
  );
  const res = await fetch(`/__shiki/snap?name=${encodeURIComponent(name)}`, { method: 'POST', body: url });
  return ((await res.json()) as { file: string }).file;
}

if (import.meta.env.DEV) {
  Object.assign(window, {
    __shiki: {
      engine, clock, audio, tracker, snap,
      select: (id: string) => { const w = list.find((x) => x.manifest.id === id); if (w) selectWork(w); return engine.workId; },
      setKnob: (id: string, v: number) => {
        const i = engine.manifest?.macros.findIndex((m) => m.id === id) ?? -1;
        if (i >= 0) { engine.knobs[i] = v; renderMacros(); }
      },
      testTrack: useTestTrack,
      signals: () => latest,
    },
  });
}

// ---------- start ----------
renderWorks();
const first = list.find((w) => w.manifest.id === 'moonsea') ?? list[0];
if (first) selectWork(first);
engine.start();
ui();
