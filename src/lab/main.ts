// WebGPU lab: runs one world full-window on the WebGPU renderer, with the test track or scripted signals, and renders
// deterministic offline clips (window.__lab.offline). Used to build worlds before the WebGPU DeckEngine is wired into
// the control window.  http://localhost:5173/lab.html?work=alien-signal
import { HalfFloatType, MeshBasicNodeMaterial, QuadMesh, RenderTarget, WebGPURenderer, ACESFilmicToneMapping, SRGBColorSpace } from 'three/webgpu';
import { texture, uniform } from 'three/tsl';
import { loadWorks } from '../works/registry';
import { Clock } from '../engine/Clock';
import { AudioEngine } from '../audio/AudioEngine';
import { BeatTracker } from '../audio/BeatTracker';
import { Choreography } from '../audio/Choreography';
import { MAX_MACROS, SILENT } from '../engine/types';
import type { LiveSignals, Signals } from '../engine/types';
import type { GpuInstrument, GpuInstrumentModule } from '../engine/gpu/types';

const canvas = document.createElement('canvas');
canvas.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;display:block;background:#000';
document.body.style.cssText = 'margin:0;background:#000;overflow:hidden;color:#ece6da;font:11px ui-monospace,Menlo,monospace';
document.body.append(canvas);
const hud = document.createElement('div');
hud.style.cssText = 'position:fixed;left:12px;bottom:10px;opacity:.7;pointer-events:none;white-space:pre';
document.body.append(hud);

const renderer = new WebGPURenderer({ canvas, antialias: false });
await renderer.init();
renderer.toneMapping = ACESFilmicToneMapping;
renderer.outputColorSpace = SRGBColorSpace;

const res = await loadWorks();
const want = new URLSearchParams(location.search).get('work');
const mod: GpuInstrumentModule | undefined = res.gpuWorks.find((w) => w.manifest.id === want) ?? res.gpuWorks[0];
if (!mod) throw new Error('No WebGPU world found (works/*/index.ts with defineGpuInstrument)');
document.title = `SHIKI lab — ${mod.manifest.name}`;

const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
let w = Math.round(innerWidth * dpr);
let h = Math.round(innerHeight * dpr);
renderer.setPixelRatio(1);
renderer.setSize(w, h, false);
const hdr = new RenderTarget(w, h, { type: HalfFloatType, depthBuffer: true });
const exposure = uniform(1);
const finishMat = new MeshBasicNodeMaterial();
finishMat.colorNode = texture(hdr.texture).mul(exposure);
const finish = new QuadMesh(finishMat);

const knobs = new Float32Array(MAX_MACROS);
mod.manifest.macros.forEach((m, i) => (knobs[i] = m.default));
const macros = new Float32Array(MAX_MACROS);
let instrument: GpuInstrument = await mod.create({ renderer, manifest: mod.manifest, width: w, height: h });

/** A new instance of the world, so a scripted render starts from the same state every time (deterministic). */
async function fresh() {
  instrument.dispose();
  instrument = await mod!.create({ renderer, manifest: mod!.manifest, width: w, height: h });
  (window as unknown as { __lab: { instrument: GpuInstrument } }).__lab.instrument = instrument;
}

addEventListener('resize', () => {
  w = Math.round(innerWidth * dpr);
  h = Math.round(innerHeight * dpr);
  renderer.setSize(w, h, false);
  hdr.setSize(w, h);
  instrument.resize?.(w, h);
});

// ---------- live signals ----------
const clock = new Clock();
const audio = new AudioEngine();
const tracker = new BeatTracker();
const choreo = new Choreography();
let last = performance.now();
let frameNo = 0;

function live(now: number): LiveSignals {
  const dt = Math.min(0.1, Math.max(0.001, (now - last) / 1000));
  last = now;
  const a = audio.read(dt);
  if (audio.mode !== 'off') tracker.push(a.flux, now);
  clock.followAudio(tracker.estimate(), now);
  const c = clock.state(now);
  const ch = choreo.step(a, dt);
  return {
    bpm: c.bpm, beat: c.beat, bar: c.bar, beats: c.beats, low: a.low, mid: a.mid, high: a.high, level: a.level,
    onset: a.onset, kick: a.kick, tension: ch.tension, drop: ch.drop,
  };
}

function draw(sig: Signals) {
  mod!.manifest.macros.forEach((m, i) => {
    macros[i] = Math.min(1, Math.max(0, knobs[i] + (m.mod ? sig[m.mod.source] * m.mod.amount : 0)));
  });
  instrument.render({ signals: sig, macros, width: w, height: h }, hdr);
  renderer.setRenderTarget(null);
  finish.render(renderer);
}

let running = true;
let fps = 60;
let prevNow = performance.now();
let lastLive: LiveSignals = { ...SILENT };
/** World time; stops while frozen so a moment can be framed and printed. */
let simT = 0;
let frozen = false;
let lastSig: Signals = { ...SILENT, time: 0, dt: 1 / 60, frame: 0 };
let printNote = '';
function loop(now: number) {
  if (!running) return;
  requestAnimationFrame(loop);
  lastLive = live(now);
  const dt = Math.min(0.1, (now - prevNow) / 1000);
  prevNow = now;
  if (dt > 0) fps += (1 / dt - fps) * 0.05;
  if (!frozen) {
    simT += dt;
    lastSig = { ...lastLive, time: simT, dt, frame: frameNo++ };
    draw(lastSig);
  }
  hud.textContent = `${mod!.manifest.name}  ${Math.round(fps)} fps  ${w}×${h}  bpm ${lastLive.bpm.toFixed(1)}  tension ${lastLive.tension.toFixed(2)}  drop ${lastLive.drop.toFixed(2)}${frozen ? '  ■ FROZEN' : ''}\nT test track · M mic · SPACE tap · hold B build · ⏎ drop · F freeze · P print 4K · ⇧P print 8K${printNote ? `\n${printNote}` : ''}`;
}
requestAnimationFrame(loop);

addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') freeze(!frozen);
  else if (e.key === 'p' || e.key === 'P') void print(e.shiftKey ? { width: 7680, height: 4320 } : {});
  else if (e.key === ' ') { e.preventDefault(); clock.tap(); }
  else if (e.key === 'Enter') choreo.fire();
  else if (e.key === 'b' || e.key === 'B') choreo.building = true;
  else if (e.key === 't' || e.key === 'T') void audio.useFile('/test/testtrack-128.wav').then(() => tracker.reset());
  else if (e.key === 'm' || e.key === 'M') void audio.useMic().then(() => tracker.reset());
});
addEventListener('keyup', (e) => {
  if (e.key === 'b' || e.key === 'B') choreo.building = false;
});

// ---------- offline capture ----------
const trace: Record<string, unknown>[] = [];
/** Copies the canvas right after a render (same task) into a data URL (JPEG for clips, PNG for stills). */
function grab(quality = 0.88, type = 'image/jpeg'): string {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.drawImage(canvas, 0, 0);
  return c.toDataURL(type, quality);
}

/** Drawing size of the canvas, the HDR target and the world (the window keeps its CSS size). */
function setRes(nw: number, nh: number) {
  w = nw;
  h = nh;
  renderer.setSize(w, h, false);
  hdr.setSize(w, h);
  instrument.resize?.(w, h);
}

interface Script { buildAt?: number; dropAt?: number; bpm?: number }
/** The scripted section used by offline renders: groove → build from `buildAt` → drop at `dropAt` → groove. */
function scripted(i: number, rate: number, o: Script): Signals {
  const { buildAt = 6, dropAt = 12, bpm = 128 } = o;
  const beatS = 60 / bpm;
  const t = i / rate;
  const beats = t / beatS;
  const building = t >= buildAt && t < dropAt;
  const sinceBeat = (beats % 1) * beatS;
  const kick = building ? 0 : Math.exp(-sinceBeat / 0.12);
  return {
    bpm, beats, beat: beats % 1, bar: (beats / 4) % 1,
    low: building ? 0.25 : 0.55 + 0.35 * kick, mid: 0.45, high: building ? 0.3 + 0.6 * (t - buildAt) / (dropAt - buildAt) : 0.4,
    level: building ? 0.45 : 0.72, onset: kick, kick,
    tension: building ? Math.min(1, (t - buildAt) / (dropAt - buildAt)) : 0,
    drop: t >= dropAt ? Math.exp(-(t - dropAt) / 2.2) : 0,
    time: t, dt: 1 / rate, frame: i,
  };
}

/**
 * Deterministic clip with scripted signals: groove → build from `buildAt` (tension rises, kick stops) → drop at
 * `dropAt` → groove. Frames to .agents/frames/<name>/, result .agents/clips/<name>.mp4 (+ contact sheet).
 */
async function offline(o: { name?: string; seconds?: number; fps?: number } & Script = {}) {
  const { name = 'lab', seconds = 20, fps: rate = 30 } = o;
  running = false;
  trace.length = 0;
  try {
    await fresh();
    const total = Math.round(seconds * rate);
    for (let i = 0; i < total; i++) {
      draw(scripted(i, rate, o));
      trace.push({ t: Math.round((i / rate) * 100) / 100, ...instrument.debug?.() });
      await fetch(`/__shiki/frame?name=${encodeURIComponent(name)}&i=${i}`, { method: 'POST', body: grab() });
    }
  } finally {
    running = true;
    requestAnimationFrame(loop);
  }
  const r = await fetch(`/__shiki/encode?name=${encodeURIComponent(name)}&fps=${rate}`);
  return (await r.json()) as { mp4: string; sheet: string };
}

/**
 * A print: replays the scripted section up to `at` seconds, renders the last `settle` frames at full print size (so
 * trails and feedback have history at that size), and saves that moment as library/prints/<name>.png.
 */
async function still(o: { name: string; at: number; width?: number; height?: number; fps?: number; settle?: number } & Script) {
  const { name, at, width: pw = 3840, height: ph = 2160, fps: rate = 30, settle = 12 } = o;
  running = false;
  const sw = w;
  const sh = h;
  try {
    await fresh();
    const total = Math.round(at * rate);
    for (let i = 0; i <= total; i++) {
      if (i === Math.max(0, total - settle)) setRes(pw, ph);
      draw(scripted(i, rate, o));
      // yield now and then, but never after the last frame: the canvas image is gone once the task ends
      if (i % 8 === 7 && i < total) await new Promise((r) => setTimeout(r, 0));
    }
    const r = await fetch(`/__shiki/still?name=${encodeURIComponent(name)}`, { method: 'POST', body: grab(1, 'image/png') });
    return { ...(await r.json() as { file: string }), state: instrument.debug?.() };
  } finally {
    setRes(sw, sh);
    running = true;
    requestAnimationFrame(loop);
  }
}

// ---------- print mode: freeze a live moment, save it at print size ----------
function freeze(on: boolean) {
  frozen = on;
  printNote = on ? 'FROZEN — P で保存、F で再開' : '';
}

/** Local time, e.g. 20261008-010857 (sorts by name). */
const stamp = () => {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
};

/**
 * Saves the current live moment as library/prints/<work>/<work>-<time>.png. The world renders a few frames at print
 * size first (frozen: the same instant; live: the next ~0.15 s), so trails and feedback exist at that size too.
 */
async function print(o: { width?: number; height?: number; settle?: number } = {}) {
  if (!running) return null;
  const { width: pw = 3840, height: ph = 2160, settle = 10 } = o;
  running = false;
  const sw = w;
  const sh = h;
  const base = lastSig;
  printNote = `保存中… ${pw}×${ph}`;
  hud.textContent += `\n${printNote}`;
  try {
    setRes(pw, ph);
    for (let i = 0; i < settle; i++) {
      draw(frozen ? { ...base, dt: 1e-4, frame: frameNo++ } : { ...base, time: base.time + i / 60, dt: 1 / 60, frame: frameNo++ });
    }
    const id = mod!.manifest.id;
    const r = await fetch(`/__shiki/still?dir=${id}&name=${id}-${stamp()}`, { method: 'POST', body: grab(1, 'image/png') });
    const { file } = (await r.json()) as { file: string };
    printNote = `保存しました: ${file}`;
    return file;
  } catch (err) {
    printNote = `保存できません: ${String(err)}`;
    return null;
  } finally {
    setRes(sw, sh);
    if (frozen) draw({ ...base, dt: 1e-4, frame: frameNo++ });
    running = true;
    requestAnimationFrame(loop);
  }
}

// ?print=1 — buttons for the same actions, for printing without the keyboard shortcuts
if (new URLSearchParams(location.search).get('print')) {
  const bar = document.createElement('div');
  bar.style.cssText = 'position:fixed;right:12px;bottom:10px;display:flex;gap:6px';
  const button = (label: string, fn: () => void) => {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = 'font:11px ui-monospace,Menlo,monospace;color:#ece6da;background:rgba(20,20,20,.7);border:1px solid rgba(236,230,218,.35);padding:6px 10px;cursor:pointer';
    b.onclick = fn;
    bar.append(b);
  };
  button('テスト曲', () => void audio.useFile('/test/testtrack-128.wav').then(() => tracker.reset()));
  button('マイク', () => void audio.useMic().then(() => tracker.reset()));
  button('DROP', () => choreo.fire());
  button('止める / 再開', () => freeze(!frozen));
  button('4K で保存', () => void print());
  button('8K で保存', () => void print({ width: 7680, height: 4320 }));
  document.body.append(bar);
}

Object.assign(window, { __lab: { renderer, instrument, knobs, exposure, offline, still, print, freeze, trace, audio, clock, choreo, fps: () => fps } });
