import { Engine } from '../engine/Engine';
import { openBridge } from '../bridge';
import { loadWorks, onWorksChanged } from '../works/registry';
import { SILENT } from '../engine/types';
import type { InstrumentModule, LiveSignals } from '../engine/types';

const canvas = document.getElementById('out') as HTMLCanvasElement;
const hint = document.getElementById('hint') as HTMLDivElement;

let list: InstrumentModule[] = (await loadWorks()).works;
let latest: LiveSignals = { ...SILENT };
let lastState = 0;

const engine = new Engine({
  canvas,
  maxPixelRatio: 2,
  onError: (msg, id) => console.warn(`[shiki] ${id}: ${msg}`),
});
engine.signals = () => latest;

const bridge = openBridge((m) => {
  if (m.t !== 'state') return;
  lastState = performance.now();
  if (m.workId && m.workId !== engine.workId) {
    const w = list.find((x) => x.manifest.id === m.workId);
    if (w) engine.load(w, { keepKnobs: true });
  }
  engine.knobs.set(m.knobs.slice(0, engine.knobs.length));
  latest = m.signals;
  engine.exposure = m.exposure;
});
bridge.send({ t: 'hello' });

onWorksChanged(({ works: fresh }) => {
  list = fresh;
  const w = fresh.find((x) => x.manifest.id === engine.workId);
  if (w) engine.load(w, { keepKnobs: true });
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
