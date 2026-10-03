import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import type { IncomingMessage } from 'node:http';
import { execFile } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const path = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const run = promisify(execFile);

function body(req: IncomingMessage): Promise<Buffer> {
  return new Promise((done) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => done(Buffer.concat(chunks)));
  });
}

function nameOf(req: IncomingMessage, fallback: string): string {
  return (new URL(req.url ?? '/', 'http://local').searchParams.get('name') ?? fallback).replace(/[^a-z0-9_-]/gi, '-');
}

/**
 * Dev-only endpoints that let agents look at their own work:
 *   POST /__shiki/snap?name=x  (canvas data URL) → .agents/snaps/x.jpg
 *   POST /__shiki/clip?name=x  (webm blob)       → .agents/clips/x.mp4 + x-sheet.jpg (contact sheet, needs ffmpeg)
 */
function agentEyes(): Plugin {
  return {
    name: 'shiki-agent-eyes',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__shiki/snap', async (req, res) => {
        if (req.method !== 'POST') return void res.writeHead(405).end();
        const b64 = (await body(req)).toString().replace(/^data:image\/\w+;base64,/, '');
        const dir = path('./.agents/snaps');
        mkdirSync(dir, { recursive: true });
        const file = `${dir}/${nameOf(req, 'snap')}.jpg`;
        writeFileSync(file, Buffer.from(b64, 'base64'));
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ file }));
      });
      // Offline capture: frames are posted one by one, then encoded at a fixed rate.
      server.middlewares.use('/__shiki/frame', async (req, res) => {
        if (req.method !== 'POST') return void res.writeHead(405).end();
        const url = new URL(req.url ?? '/', 'http://local');
        const index = Number(url.searchParams.get('i') ?? 0);
        const dir = path(`./.agents/frames/${nameOf(req, 'offline')}`);
        mkdirSync(dir, { recursive: true });
        const b64 = (await body(req)).toString().replace(/^data:image\/\w+;base64,/, '');
        writeFileSync(`${dir}/${String(index).padStart(5, '0')}.jpg`, Buffer.from(b64, 'base64'));
        res.end('ok');
      });
      server.middlewares.use('/__shiki/encode', async (req, res) => {
        const url = new URL(req.url ?? '/', 'http://local');
        const name = nameOf(req, 'offline');
        const fps = String(Number(url.searchParams.get('fps') ?? 30));
        const frames = path(`./.agents/frames/${name}`);
        const out = path('./.agents/clips');
        mkdirSync(out, { recursive: true });
        try {
          const scale = 'scale=trunc(iw/2)*2:trunc(ih/2)*2';
          await run('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', fps, '-i', `${frames}/%05d.jpg`, '-vf', scale, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-movflags', '+faststart', `${out}/${name}.mp4`]);
          await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${out}/${name}.mp4`, '-vf', 'fps=1,scale=480:-2,tile=4x4', '-frames:v', '1', `${out}/${name}-sheet.jpg`]);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ mp4: `${out}/${name}.mp4`, sheet: `${out}/${name}-sheet.jpg` }));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
      server.middlewares.use('/__shiki/clip', async (req, res) => {
        if (req.method !== 'POST') return void res.writeHead(405).end();
        const dir = path('./.agents/clips');
        mkdirSync(dir, { recursive: true });
        const base = `${dir}/${nameOf(req, 'clip')}`;
        writeFileSync(`${base}.webm`, await body(req));
        try {
          await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${base}.webm`, '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '20', '-movflags', '+faststart', `${base}.mp4`]);
          await run('ffmpeg', ['-y', '-loglevel', 'error', '-i', `${base}.webm`, '-vf', 'fps=1.5,scale=480:-2,tile=4x3', '-frames:v', '1', `${base}-sheet.jpg`]);
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ mp4: `${base}.mp4`, sheet: `${base}-sheet.jpg` }));
        } catch (err) {
          res.statusCode = 500;
          res.end(JSON.stringify({ error: String(err) }));
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [agentEyes()],
  // No error overlay: a broken work must never cover the output. Errors go to the control window's panel.
  server: { port: 5173, strictPort: true, hmr: { overlay: false } },
  build: {
    target: 'es2022',
    rollupOptions: { input: { control: path('./index.html'), output: path('./output.html') } },
  },
  test: { include: ['src/**/*.test.ts', 'works/**/*.test.ts'] },
});
