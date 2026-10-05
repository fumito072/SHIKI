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
const instrument: GpuInstrument = await mod.create({ renderer, manifest: mod.manifest, width: w, height: h });

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
const t0 = performance.now();
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
function loop(now: number) {
  if (!running) return;
  requestAnimationFrame(loop);
  lastLive = live(now);
  const dt = Math.min(0.1, (now - prevNow) / 1000);
  prevNow = now;
  if (dt > 0) fps += (1 / dt - fps) * 0.05;
  draw({ ...lastLive, time: (now - t0) / 1000, dt, frame: frameNo++ });
  hud.textContent = `${mod!.manifest.name}  ${Math.round(fps)} fps  ${w}×${h}  bpm ${lastLive.bpm.toFixed(1)}  tension ${lastLive.tension.toFixed(2)}  drop ${lastLive.drop.toFixed(2)}\nT test track · M mic · SPACE tap · hold B build · ⏎ drop`;
}
requestAnimationFrame(loop);

addEventListener('keydown', (e) => {
  if (e.key === ' ') { e.preventDefault(); clock.tap(); }
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
/** Copies the canvas right after a render (same task) into a JPEG data URL. */
function grab(quality = 0.88): string {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  c.getContext('2d')!.drawImage(canvas, 0, 0);
  return c.toDataURL('image/jpeg', quality);
}

/**
 * Deterministic clip with scripted signals: groove → build from `buildAt` (tension rises, kick stops) → drop at
 * `dropAt` → groove. Frames to .agents/frames/<name>/, result .agents/clips/<name>.mp4 (+ contact sheet).
 */
async function offline(o: { name?: string; seconds?: number; fps?: number; buildAt?: number; dropAt?: number; bpm?: number } = {}) {
  const { name = 'lab', seconds = 20, fps: rate = 30, buildAt = 6, dropAt = 12, bpm = 128 } = o;
  running = false;
  trace.length = 0;
  const beatS = 60 / bpm;
  try {
    const total = Math.round(seconds * rate);
    for (let i = 0; i < total; i++) {
      const t = i / rate;
      const beats = t / beatS;
      const building = t >= buildAt && t < dropAt;
      const sinceBeat = (beats % 1) * beatS;
      const kick = building ? 0 : Math.exp(-sinceBeat / 0.12);
      const sig: Signals = {
        bpm, beats, beat: beats % 1, bar: (beats / 4) % 1,
        low: building ? 0.25 : 0.55 + 0.35 * kick, mid: 0.45, high: building ? 0.3 + 0.6 * (t - buildAt) / (dropAt - buildAt) : 0.4,
        level: building ? 0.45 : 0.72, onset: kick, kick,
        tension: building ? Math.min(1, (t - buildAt) / (dropAt - buildAt)) : 0,
        drop: t >= dropAt ? Math.exp(-(t - dropAt) / 2.2) : 0,
        time: t, dt: 1 / rate, frame: i,
      };
      draw(sig);
      trace.push({ t: Math.round(t * 100) / 100, ...instrument.debug?.() });
      await fetch(`/__shiki/frame?name=${encodeURIComponent(name)}&i=${i}`, { method: 'POST', body: grab() });
    }
  } finally {
    running = true;
    requestAnimationFrame(loop);
  }
  const r = await fetch(`/__shiki/encode?name=${encodeURIComponent(name)}&fps=${rate}`);
  return (await r.json()) as { mp4: string; sheet: string };
}

Object.assign(window, { __lab: { renderer, instrument, knobs, exposure, offline, trace, audio, clock, choreo, fps: () => fps } });
