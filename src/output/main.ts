import { DeckEngine } from '../engine/DeckEngine';
import { openBridge } from '../bridge';
import { loadWorks, onWorksChanged } from '../works/registry';
import { SILENT } from '../engine/types';
import type { InstrumentModule, LiveSignals } from '../engine/types';

const canvas = document.getElementById('out') as HTMLCanvasElement;
const hint = document.getElementById('hint') as HTMLDivElement;

let list: InstrumentModule[] = (await loadWorks()).works;
let latest: LiveSignals = { ...SILENT };
let lastState = 0;

// Mirrors the control window: same works per deck, same knobs, same take schedule, FX and panic state.
const engine = new DeckEngine({
  canvas,
  maxPixelRatio: 2,
  onError: (msg, id, deck) => console.warn(`[shiki] ${deck} ${id}: ${msg}`),
});
engine.signals = () => latest;

const find = (id: string | null) => (id ? list.find((x) => x.manifest.id === id) : undefined);

const bridge = openBridge((m) => {
  if (m.t !== 'state') return;
  lastState = performance.now();
  for (const deck of ['A', 'B'] as const) {
    const want = m.decks[deck];
    if (want.workId && want.workId !== engine.workId(deck)) {
      const w = find(want.workId);
      if (w) engine.load(deck, w, { keepKnobs: true });
    }
    engine.knobs[deck].set(want.knobs.slice(0, engine.knobs[deck].length));
  }
  if (m.safeId && m.safeId !== engine.workId('safe')) {
    const w = find(m.safeId);
    if (w) engine.setSafe(w);
  }
  engine.applySync(m.sync);
  latest = m.signals;
  engine.exposure = m.exposure;
});
bridge.send({ t: 'hello' });

onWorksChanged(({ works: fresh }) => {
  list = fresh;
  for (const deck of ['A', 'B'] as const) {
    const w = find(engine.workId(deck));
    if (w) engine.load(deck, w, { keepKnobs: true });
  }
  const safe = find(engine.workId('safe'));
  if (safe) engine.setSafe(safe);
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
