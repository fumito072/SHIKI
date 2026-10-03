import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decodeRef, safePath, Store } from './store';
import type { Round } from './types';

const png = Buffer.from('89504e470d0a1a0a', 'hex');
const ref = `data:image/png;base64,${png.toString('base64')}`;
const roots: string[] = [];
function setup() { const root = mkdtempSync(join(tmpdir(), 'shiki-store-')); roots.push(root); return new Store(root); }
afterEach(() => { roots.forEach(root => rmSync(root, { recursive: true, force: true })); roots.length = 0; });
function images(store: Store, id: string) {
  const p = store.get(id);
  p.rounds = ['look', 'motion'].map((stage, n) => ({ n: n + 1, stage, feedback: '', director: { agent: 'codex', model: 'model', effort: 'low', notes: '意図' }, at: Date.now(), items: [
    { id: `${stage}-r${n + 1}-01`, file: `${stage}/r${n + 1}-01.png`, engine: 'gpt-image', prompt: 'prompt', title: 'title', status: 'done', rating: 0, note: '' },
  ] })) as Round[];
  for (const r of p.rounds) { mkdirSync(join(store.dir(id), r.stage)); writeFileSync(store.file(id, r.items[0].file!), png); }
  store.save(p); return p;
}

describe('Studio store', () => {
  it('persists projects, unique title slugs, references, updates and covers', () => {
    const store = setup(), p = store.create('Silver Tide', 'brief', [ref]);
    expect(p.id).toBe('silver-tide');
    expect(store.create('Silver Tide', 'brief').id).toBe('silver-tide-2');
    expect(store.create('日本語の題材', 'brief').id).toMatch(/^project-[a-f0-9]{8}$/);
    expect(store.get(p.id).refs).toEqual(['refs/01.png']);
    expect(store.update(p.id, 'Other', 'new').brief).toBe('new');
    expect(store.update(p.id, undefined, undefined).id).toBe(p.id);
    expect(store.addRefs(p.id, [ref]).refs).toHaveLength(2);
    expect(store.removeRef(p.id, 'refs/01.png').refs).toEqual(['refs/02.png']);
    expect(() => store.removeRef(p.id, 'project.json')).toThrow('Unknown reference');
    images(store, p.id);
    expect(store.list().find(i => i.id === p.id)?.cover).toContain('path=motion%2Fr2-01.png');
  });
  it('persists ratings and ordered selections, clearing studies after a new look choice', () => {
    const store = setup(), p = store.create('Test', 'brief'); images(store, p.id);
    const look = 'look-r1-01', motion = 'motion-r2-01';
    expect(store.rate(p.id, look, 1, '余白を維持').rounds[0].items[0]).toMatchObject({ rating: 1, note: '余白を維持' });
    expect(store.choose(p.id, look, undefined).stage).toBe('motion');
    expect(store.list()[0].cover).toContain('look%2Fr1-01.png');
    expect(store.choose(p.id, undefined, [motion]).studies).toEqual([motion]);
    expect(store.choose(p.id, look, undefined).studies).toEqual([]);
    expect(() => store.choose(p.id, motion, undefined)).toThrow('Unknown item');
    expect(() => store.choose(p.id, undefined, [look])).toThrow('Unknown item');
    expect(() => store.choose(p.id, undefined, [motion, motion])).toThrow('Invalid studies');
    expect(() => store.rate(p.id, look, 2, undefined)).toThrow('Invalid rating');
    const q = store.get(p.id); q.rounds[0].items[0].status = 'error'; store.save(q);
    expect(() => store.choose(p.id, look, undefined)).toThrow('not ready');
  });
  it('rejects invalid ids, traversal, symlinks, non-image files and excessive references', () => {
    const store = setup(), p = store.create('Test', 'brief');
    for (const id of ['../foo', 'A', 'x'.repeat(42), null]) expect(() => store.get(id)).toThrow('Invalid project id');
    for (const path of ['../outside.png', '/etc/passwd', 'x/../project.json', 'x\\y', '', 'x\0', 'x//y', './x']) expect(() => safePath(store.dir(p.id), path)).toThrow();
    symlinkSync('/does-not-exist', join(store.dir(p.id), 'linked'));
    expect(() => store.file(p.id, 'linked/a.png')).toThrow('Symlink');
    symlinkSync(tmpdir(), join(store.dir(p.id), 'outside'));
    expect(() => store.file(p.id, 'outside/a.png')).toThrow('Symlink');
    expect(() => store.image(p.id, 'project.json')).toThrow('Image files only');
    expect(() => store.addRefs(p.id, Array(9).fill(ref))).toThrow('At most 8');
    expect(() => store.create('', 'brief')).toThrow('Invalid title');
    expect(() => store.get('unknown')).toThrow('Unknown project');
  });
  it('validates MIME, base64 and the data URL size before writing', () => {
    expect(decodeRef(ref).ext).toBe('png');
    for (const input of ['data:image/svg+xml;base64,AAAA', 'data:image/png;base64,AAAA', 'data:image/jpeg;base64,AA', 'data:image/png;base64,A===', 4]) expect(() => decodeRef(input)).toThrow();
    expect(() => decodeRef('x'.repeat(12 * 1024 * 1024 + 1))).toThrow('12 MB');
  });
});
