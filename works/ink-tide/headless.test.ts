import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { expect, it, vi } from 'vitest';
import { ShaderChunk } from 'three';
import type { IUniform, Texture, WebGLRenderer, WebGLRenderTarget } from 'three';

const native = vi.hoisted(() => ({
  shaders: [] as string[], commands: [] as string[],
  textures: new Map<Texture, number>(), time: 0,
}));

vi.mock('../../src/engine/passes', async importOriginal => {
  const actual = await importOriginal<typeof import('../../src/engine/passes')>();
  function texture(value: Texture, target?: WebGLRenderTarget) {
    const found = native.textures.get(value);
    if (found !== undefined) return found;
    const id = native.textures.size;
    native.textures.set(value, id);
    const image = value.image as { width: number; height: number };
    native.commands.push(`T ${id} ${target?.width ?? image.width} ${target?.height ?? image.height}`);
    return id;
  }
  class Pass {
    id: number;
    constructor(readonly options: { fragmentShader: string; uniforms: Record<string, IUniform> }) {
      this.id = native.shaders.push(options.fragmentShader) - 1;
    }
    render(_renderer: WebGLRenderer, target: WebGLRenderTarget) {
      const destination = texture(target.texture, target);
      native.commands.push(`P ${this.id}`);
      let unit = 0;
      for (const [name, { value }] of Object.entries(this.options.uniforms)) {
        if (value?.isTexture) {
          expect(value).not.toBe(target.texture);
          native.commands.push(`S ${name} ${unit++} ${texture(value)}`);
        } else if (value?.isVector2) native.commands.push(`V ${name} ${value.x} ${value.y}`);
        else if (value instanceof Float32Array) native.commands.push(`A ${name} ${value.length} ${Array.from(value).join(' ')}`);
        else native.commands.push(`F ${name} ${value}`);
      }
      native.commands.push(`D ${destination}`);
      const kind = this.options.fragmentShader.match(/INK TIDE: (\w+)/)?.[1];
      if (kind === 'advect' || kind === 'project') native.commands.push(`B 0 ${destination}`);
      if (kind === 'dye' || kind === 'replay' || !kind && 'uSeedKind' in this.options.uniforms) native.commands.push(`B 1 ${destination}`);
      if (kind === 'ink') native.commands.push(`B 2 ${destination}`);
    }
    dispose() {}
  }
  return { ...actual, FullscreenPass: Pass, CopyPass: class {
    pass = new Pass({ fragmentShader: 'uniform sampler2D uTex; varying vec2 vUv; void main(){ gl_FragColor=texture2D(uTex,vUv); }',
      uniforms: { uTex: { value: null } } });
    render(renderer: WebGLRenderer, source: Texture, target: WebGLRenderTarget) {
      this.pass.options.uniforms.uTex.value = source;
      this.pass.render(renderer, target);
    }
    dispose() {}
  } };
});

import ink from './index';
import { createTarget } from '../../src/engine/passes';
import { offlineSignals } from './timeline.fixture';

// Native CGL executes the actual generated shaders and actual instrument draw order.
it.runIf(process.platform === 'darwin')('keeps the full 16-second offline simulation bounded and re-blooms within two seconds', async () => {
  native.shaders.length = 0;
  native.commands.length = 0;
  native.textures.clear();
  const renderer = {} as WebGLRenderer;
  const width = 384, height = 216;
  const target = createTarget(width / 4, height / 4);
  const work = ink.create({ renderer, manifest: ink.manifest, width, height });
  for (let i = 0; i < 480; i++) {
    native.time = i / 30;
    native.commands.push(`N ${native.time}`);
    const signals = offlineSignals(native.time);
    const macros = new Float32Array(ink.manifest.macros.map(m => Math.min(1, m.default
      + (m.mod ? signals[m.mod.source] * m.mod.amount : 0))));
    work.render({ signals, macros, width, height }, target);
    if (i % 30 === 0) native.commands.push(`O ${native.textures.get(target.texture)} ${i / 30}`);
  }
  work.dispose();
  target.dispose();
  const dir = mkdtempSync(join(tmpdir(), 'ink-tide-gpu-'));
  try {
    const chunks = ShaderChunk as unknown as Record<string, string>;
    native.shaders.forEach((shader, id) => {
      const expanded = shader.replace(/#include <(\w+)>/g, (_, key: string) => chunks[key]);
      writeFileSync(join(dir, `${id}.frag`), '#version 150\n#define texture2D texture\nout vec4 fragColor;\n'
        + expanded.replace(/varying /g, 'in ').replace(/gl_FragColor/g, 'fragColor'));
    });
    writeFileSync(join(dir, 'commands'), native.commands.join('\n'));
    const executable = join(dir, 'simulate');
    execFileSync('/usr/bin/clang', ['-Wno-deprecated-declarations', '-O2', '-framework', 'OpenGL',
      join(import.meta.dirname, 'headless.c'), '-o', executable], { timeout: 30_000 });
    const { stdout: output } = await promisify(execFile)(executable, [dir, String(native.shaders.length)], { encoding: 'utf8', timeout: 300_000 });
    expect(output).toContain('PASS: finite velocity/dye/material, clear walls, interior gather, left burst, rebloom');
    // Keep compact per-second metrics in the test output.
    console.info(output.trim());
    if (process.env.INK_TIDE_CAPTURE_DIR) {
      for (let i = 0; i < 16; i++) writeFileSync(join(process.env.INK_TIDE_CAPTURE_DIR, `${i}.ppm`), readFileSync(join(dir, `${i}.ppm`)));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 330_000);
