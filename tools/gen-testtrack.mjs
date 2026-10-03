// Writes public/test/testtrack-128.wav: a 32-bar synthetic 128 BPM track with structure, for choreography checks.
//   bars  1–8   groove      (kick, clap, 8th hats, bass)
//   bars  9–12  breakdown   (no kick, no bass; pad and sparse hats)        → tension rises
//   bars 13–16  build       (no kick; snare roll 8ths→16ths→32nds, riser)  → tension peaks
//   bars 17–28  drop        (full groove, 16th hats)                       → drop fires on bar 17
//   bars 29–32  outro       (kick and pad)
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const RATE = 44100;
const BPM = 128;
const BARS = 32;
const beat = 60 / BPM;
const total = Math.round(BARS * 4 * beat * RATE);
const out = new Float32Array(total);

let seed = 7;
const noise = () => {
  seed = (seed * 1664525 + 1013904223) >>> 0;
  return seed / 2 ** 31 - 1;
};

function add(start, len, fn) {
  const s0 = Math.round(start * RATE);
  const n = Math.min(Math.round(len * RATE), total - s0);
  for (let i = 0; i < n; i++) out[s0 + i] += fn(i / RATE);
}

const kick = (t) => Math.sin(2 * Math.PI * (45 + 90 * Math.exp(-t * 28)) * t) * Math.exp(-t * 7) * 0.9;
const clap = (t) => noise() * Math.exp(-t * 22) * 0.35;
const snare = (gain) => (t) => (noise() * 0.8 + Math.sin(2 * Math.PI * 190 * t) * 0.3) * Math.exp(-t * 30) * gain;
const hat = (t) => (noise() - 0.5 * noise()) * Math.exp(-t * 90) * 0.18;
const bassNotes = [41.2, 41.2, 49.0, 36.7];
const padNotes = [110, 130.8, 164.8, 196];

const section = (bar) => (bar < 8 ? 'groove' : bar < 12 ? 'breakdown' : bar < 16 ? 'build' : bar < 28 ? 'drop' : 'outro');

for (let b = 0; b < BARS * 4; b++) {
  const t = b * beat;
  const bar = Math.floor(b / 4);
  const sec = section(bar);
  const hasKick = sec === 'groove' || sec === 'drop' || sec === 'outro';
  if (hasKick) add(t, 0.45, kick);
  if ((sec === 'groove' || sec === 'drop') && (b % 4 === 1 || b % 4 === 3)) add(t, 0.25, clap);
  if (sec !== 'outro') add(t + beat / 2, 0.06, hat);
  if (sec === 'drop') {
    add(t + beat / 4, 0.04, hat);
    add(t + (3 * beat) / 4, 0.04, hat);
  }
  if (sec === 'groove' || sec === 'drop') {
    const f = bassNotes[bar % 4];
    add(t + beat / 2, beat / 2, (x) => {
      const env = Math.min(1, x * 80) * Math.exp(-x * 4);
      return (Math.sin(2 * Math.PI * f * x) + 0.3 * Math.sin(4 * Math.PI * f * x)) * env * 0.35;
    });
  }
  if (sec === 'build') {
    // Snare roll: 8ths, then 16ths, then 32nds, getting louder.
    const k = bar - 12;
    const div = k < 2 ? 2 : k < 3 ? 4 : 8;
    for (let i = 0; i < div; i++) add(t + (i * beat) / div, 0.12, snare(0.12 + 0.07 * k));
  }
}

// Pad through breakdown and build, a noise riser through the build, pad again in the outro.
const barLen = 4 * beat;
add(8 * barLen, 8 * barLen, (x) => {
  const env = Math.min(1, x / 2) * 0.12;
  return padNotes.reduce((s, f) => s + Math.sin(2 * Math.PI * f * x), 0) * env;
});
add(12 * barLen, 4 * barLen, (x) => {
  const p = x / (4 * barLen);
  return noise() * p * p * 0.25 + Math.sin(2 * Math.PI * (200 + 1800 * p * p) * x) * p * 0.05;
});
add(28 * barLen, 4 * barLen, (x) => padNotes.reduce((s, f) => s + Math.sin(2 * Math.PI * f * x), 0) * 0.08 * Math.min(1, x));

let peak = 0;
for (const v of out) peak = Math.max(peak, Math.abs(v));
const pcm = Buffer.alloc(44 + total * 2);
pcm.write('RIFF', 0);
pcm.writeUInt32LE(36 + total * 2, 4);
pcm.write('WAVE', 8);
pcm.write('fmt ', 12);
pcm.writeUInt32LE(16, 16);
pcm.writeUInt16LE(1, 20);
pcm.writeUInt16LE(1, 22);
pcm.writeUInt32LE(RATE, 24);
pcm.writeUInt32LE(RATE * 2, 28);
pcm.writeUInt16LE(2, 32);
pcm.writeUInt16LE(16, 34);
pcm.write('data', 36);
pcm.writeUInt32LE(total * 2, 40);
for (let i = 0; i < total; i++) pcm.writeInt16LE(Math.round((out[i] / peak) * 0.89 * 32767), 44 + i * 2);

const file = resolve(dirname(fileURLToPath(import.meta.url)), '../public/test/testtrack-128.wav');
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, pcm);
console.log(`wrote ${file} (${(total / RATE).toFixed(1)} s, ${BPM} BPM, groove/breakdown/build/drop/outro)`);
