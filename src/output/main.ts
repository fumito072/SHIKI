import { DeckEngine } from '../engine/DeckEngine';
import { GpuDeckEngine } from '../engine/gpu/DeckEngine';
import { openBridge } from '../bridge';
import { loadWorks, onWorksChanged } from '../works/registry';
import { SILENT } from '../engine/types';
import type { InstrumentModule, LiveSignals } from '../engine/types';
import type { LoadResult } from '../works/registry';

const canvas = document.getElementById('out') as HTMLCanvasElement;
const hint = document.getElementById('hint') as HTMLDivElement;

// Same backend as the control window (its header toggle writes this key; we reload when it changes).
const engineMode: 'gpu' | 'gl' = (() => {
  try {
    return localStorage.getItem('shiki.engine') === 'gl' ? 'gl' : 'gpu';
  } catch {
    return 'gpu';
  }
})();
window.addEventListener('storage', (e) => {
  if (e.key === 'shiki.engine') location.reload();
});
const worksOf = (res: Pick<LoadResult, 'works' | 'gpuWorks'>): InstrumentModule[] =>
  engineMode === 'gpu' ? (res.gpuWorks as unknown as InstrumentModule[]) : res.works;

let list: InstrumentModule[] = worksOf(await loadWorks());
let latest: LiveSignals = { ...SILENT };
let lastState = 0;

// Mirrors the control window: same works per deck, same knobs, same take schedule, FX and panic state.
const opts: ConstructorParameters<typeof DeckEngine>[0] = {
  canvas,
  maxPixelRatio: 2,
  onError: (msg, id, deck) => console.warn(`[shiki] ${deck} ${id}: ${msg}`),
};
const engine = (engineMode === 'gpu' ? await GpuDeckEngine.create(opts as never) : new DeckEngine(opts)) as unknown as DeckEngine;
engine.signals = () => latest;

const find = (id: string | null) => (id ? list.find((x) => x.manifest.id === id) : undefined);

// WebGPU loads are asynchronous: remember what is on its way so state messages do not restart it every frame.
const inflight: Record<'A' | 'B' | 'safe', string | null> = { A: null, B: null, safe: null };
function follow(deck: 'A' | 'B' | 'safe', w: InstrumentModule, keepKnobs = true) {
  if (inflight[deck] === w.manifest.id) return;
  inflight[deck] = w.manifest.id;
  const done = () => {
    if (inflight[deck] === w.manifest.id) inflight[deck] = null;
  };
  const r = (deck === 'safe' ? engine.setSafe(w) : engine.load(deck, w, { keepKnobs })) as boolean | Promise<boolean>;
  void Promise.resolve(r).then(done, done);
}

const bridge = openBridge((m) => {
  if (m.t !== 'state') return;
  lastState = performance.now();
  for (const deck of ['A', 'B'] as const) {
    const want = m.decks[deck];
    if (want.workId && want.workId !== engine.workId(deck)) {
      const w = find(want.workId);
      if (w) follow(deck, w);
    }
    engine.knobs[deck].set(want.knobs.slice(0, engine.knobs[deck].length));
  }
  if (m.safeId && m.safeId !== engine.workId('safe')) {
    const w = find(m.safeId);
    if (w) follow('safe', w);
  }
  engine.applySync(m.sync);
  latest = m.signals;
  engine.exposure = m.exposure;
});
bridge.send({ t: 'hello' });

onWorksChanged((res) => {
  list = worksOf(res);
  for (const deck of ['A', 'B'] as const) {
    const w = find(engine.workId(deck));
    if (w) void engine.load(deck, w, { keepKnobs: true });
  }
  const safe = find(engine.workId('safe'));
  if (safe) void engine.setSafe(safe);
});

engine.start();

if (import.meta.env.DEV) Object.assign(window, { __shikiOut: { engine, signals: () => latest } });

// Report to the control window; explain ourselves while nothing drives us.
setInterval(() => {
  bridge.send({ t: 'alive', fps: Math.round(engine.fps), width: canvas.width, height: canvas.height });
  if (performance.now() - lastState > 2000) {
    hint.textContent = 'control ウィンドウ（http://localhost:5173）を開いてください';
    hint.classList.remove('gone');
  }
}, 1000);

const fullscreen = () => {
  if (document.fullscreenElement) void document.exitFullscreen();
  else void document.documentElement.requestFullscreen();
};
window.addEventListener('dblclick', fullscreen);
window.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') fullscreen();
});

// Hide the hint and the cursor after a moment of stillness.
let idle = 0;
const wake = () => {
  document.body.classList.remove('idle');
  window.clearTimeout(idle);
  idle = window.setTimeout(() => {
    document.body.classList.add('idle');
    if (performance.now() - lastState < 2000) hint.classList.add('gone');
  }, 2500);
};
window.addEventListener('mousemove', wake);
wake();
