import { afterEach, describe, expect, it, vi } from 'vitest';
import { createServer, IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import type { Server, RequestListener } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LoraClient } from './lora';

const roots: string[] = [], servers: Server[] = [];
const png = Buffer.from('89504e470d0a1a0a', 'hex');
async function local(handler: RequestListener): Promise<{ base: string; transport: typeof fetch }> {
  const server = createServer(handler); servers.push(server);
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
    });
    const addr = server.address();
    return { base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, transport: fetch };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error;
    // Run the same HTTP server handler in-process when the sandbox forbids TCP listen.
    const transport: typeof fetch = async (input, init = {}) => new Promise<Response>((resolve, reject) => {
      const req = new IncomingMessage(new Socket());
      req.url = new URL(String(input)).pathname; req.method = init.method ?? 'GET'; req.complete = true;
      const res = new ServerResponse(req);
      res.end = ((data?: string | Buffer) => {
        resolve(new Response(Buffer.isBuffer(data) ? Uint8Array.from(data) : data ?? '', { status: res.statusCode })); return res;
      }) as typeof res.end;
      init.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      req.push(init.body ? Buffer.from(String(init.body)) : null);
      if (init.body) req.push(null);
      server.emit('request', req, res);
    });
    return { base: 'http://127.0.0.1:7860', transport };
  }
}
function root() { const value = mkdtempSync(join(tmpdir(), 'shiki-lora-')); roots.push(value); return value; }
async function body(req: IncomingMessage) { let text = ''; for await (const chunk of req) text += chunk; return JSON.parse(text); }
afterEach(async () => {
  await Promise.all(servers.splice(0).map(s => new Promise<void>(resolve => s.close(() => resolve()))));
  roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true }));
});

describe('LoRA client with local fake HTTP server', () => {
  it('retries 409, polls for a new result and serializes generation requests', async () => {
    let phase = 'idle', tries = 0, active = 0, peak = 0;
    const results: { file: string; prompt: string }[] = [{ file: 'old.png', prompt: 'old' }];
    const payloads: Record<string, unknown>[] = [];
    const { base, transport } = await local(async (req, res) => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/api/state') return void res.end(JSON.stringify({ phase, message: 'ready', results }));
      if (req.url === '/api/config') return void res.end(JSON.stringify({ loaded: 'fumito_fila-final.safetensors' }));
      if (req.url === '/api/generate') {
        const value = await body(req);
        if (++tries === 1) return void res.writeHead(409).end('{}');
        payloads.push(value); active++; peak = Math.max(peak, active); phase = 'running';
        setTimeout(() => { results.unshift({ file: `new-${tries}.png`, prompt: `fmtfila, ${value.prompt}` }); active--; phase = 'idle'; }, 15);
        return void res.end('{"ok":true}');
      }
      if (req.url?.startsWith('/gallery/new-')) return void res.writeHead(200, { 'content-type': 'image/png' }).end(png);
      res.writeHead(404).end('{}');
    });
    const dir = root(), client = new LoraClient(dir, base, 2, 100, '/not-installed', transport);
    expect(await client.status()).toMatchObject({ running: true, phase: 'idle', loaded: 'fumito_fila-final.safetensors', installed: false });
    await client.start();
    const first = client.generate('first', join(dir, '1.png'));
    await vi.waitFor(() => expect(active).toBe(1), { interval: 1 });
    const controller = new AbortController();
    const queued = client.generate('cancelled', join(dir, 'cancelled.png'), .75, controller.signal);
    controller.abort();
    await expect(queued).rejects.toThrow();
    expect(active).toBe(1);
    await Promise.all([first, client.generate('second', join(dir, '2.png'), .8)]);
    expect(peak).toBe(1); expect(tries).toBe(3);
    expect(payloads).toEqual([{ prompt: 'first', weight: .75, width: 1344, height: 768, count: 1 }, { prompt: 'second', weight: .8, width: 1344, height: 768, count: 1 }]);
    expect(readFileSync(join(dir, '1.png'))).toEqual(png);
    expect(readFileSync(join(dir, '2.png'))).toEqual(png);
  });
  it('reports loading/error/missing installation and aborts polling', async () => {
    let phase = 'loading';
    const { base, transport } = await local((_req, res) => res.end(JSON.stringify({ phase, message: 'model failure', results: [] })));
    const dir = root(), client = new LoraClient(dir, base, 2, 10, '/not-installed', transport);
    await expect(client.start()).rejects.toThrow('timed out');
    phase = 'error'; await expect(client.start()).rejects.toThrow('model failure');
    const controller = new AbortController(); phase = 'running';
    const task = client.generate('never', join(dir, 'never.png'), .75, controller.signal);
    controller.abort(); await expect(task).rejects.toThrow();
    const missing = new LoraClient(dir, 'http://127.0.0.1:1', 2, 10, '/not-installed');
    expect(await missing.status()).toMatchObject({ installed: false, running: false });
    await expect(missing.start()).rejects.toThrow('not installed');
  });
  it('does not download stale results, unsafe gallery paths or non-PNG responses', async () => {
    let phase = 'idle', resultFile = '../escape.png';
    const results: { file: string; prompt: string }[] = [];
    const { base, transport } = await local(async (req, res) => {
      if (req.url === '/api/state') return void res.end(JSON.stringify({ phase, message: '', results }));
      if (req.url === '/api/generate') { await body(req); phase = 'idle'; results.unshift({ file: resultFile, prompt: 'test' }); return void res.end('{}'); }
      res.end('not PNG');
    });
    const client = new LoraClient(root(), base, 2, 10, '/not-installed', transport);
    await expect(client.generate('test', join(root(), '1.png'))).rejects.toThrow('Unsafe');
    resultFile = 'valid.png';
    await expect(client.generate('test', join(root(), '2.png'))).rejects.toThrow('not PNG');
  });
});
