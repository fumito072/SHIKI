import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const path = (p: string) => fileURLToPath(new URL(p, import.meta.url));

/** Dev-only endpoint: POST a canvas data URL to /__shiki/snap?name=x → .agents/snaps/x.jpg (lets agents look at frames). */
function snapshots(): Plugin {
  return {
    name: 'shiki-snapshots',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__shiki/snap', (req, res) => {
        if (req.method !== 'POST') {
          res.statusCode = 405;
          res.end();
          return;
        }
        const name = (new URL(req.url ?? '/', 'http://local').searchParams.get('name') ?? 'snap').replace(/[^a-z0-9_-]/gi, '-');
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          const b64 = Buffer.concat(chunks).toString().replace(/^data:image\/\w+;base64,/, '');
          const dir = path('./.agents/snaps');
          mkdirSync(dir, { recursive: true });
          const file = `${dir}/${name}.jpg`;
          writeFileSync(file, Buffer.from(b64, 'base64'));
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({ file }));
        });
      });
    },
  };
}

export default defineConfig({
  plugins: [snapshots()],
  server: { port: 5173, strictPort: true },
  build: {
    target: 'es2022',
    rollupOptions: { input: { control: path('./index.html'), output: path('./output.html') } },
  },
  test: { include: ['src/**/*.test.ts', 'works/**/*.test.ts'] },
});
