import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from './store';
import { Likes } from './likes';
import type { Round } from './types';

const png = Buffer.from('89504e470d0a1a0a', 'hex');
const roots: string[] = [];
afterEach(() => { roots.forEach((r) => rmSync(r, { recursive: true, force: true })); roots.length = 0; });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'shiki-likes-'));
  roots.push(root);
  const store = new Store(root);
  const p = store.create('Fog Pulse', 'brief');
  p.rounds = [{ n: 1, stage: 'look', feedback: '', director: { agent: 'claude', model: 'm', effort: 'low', notes: '' }, at: 1, items: [
    { id: 'look-r1-01', file: 'look/r1-01.png', engine: 'pinterest-lora', prompt: 'chrome filaments', title: '繊維', status: 'done', rating: 0, note: '' },
  ] }] as Round[];
  mkdirSync(join(store.dir(p.id), 'look'));
  writeFileSync(store.file(p.id, 'look/r1-01.png'), png);
  store.save(p);
  return { store, likes: new Likes(store, join(root, 'lib')), id: p.id };
}

describe('likes library', () => {
  it('mirrors ♥ into files with their story, and removes them on un-♥', () => {
    const { store, likes, id } = setup();
    const p = store.rate(id, 'look-r1-01', 1, 'この質感');
    likes.sync(p, store.item(p, 'look-r1-01'));
    const [e] = likes.list();
    expect(e).toMatchObject({ project: id, projectTitle: 'Fog Pulse', title: '繊維', engine: 'pinterest-lora', note: 'この質感', stage: 'look' });
    expect(readFileSync(likes.image(e.file))).toEqual(png);
    const q = store.rate(id, 'look-r1-01', 0, undefined);
    likes.sync(q, store.item(q, 'look-r1-01'));
    expect(likes.list()).toEqual([]);
    expect(existsSync(join(likes.dir, id, 'look-r1-01.png'))).toBe(false);
  });

  it('backfills likes made before the library existed and keeps the first like time', () => {
    const { store, likes, id } = setup();
    store.rate(id, 'look-r1-01', 1, undefined);
    likes.syncAll();
    const first = likes.list()[0].likedAt;
    likes.syncAll();
    expect(likes.list()).toHaveLength(1);
    expect(likes.list()[0].likedAt).toBe(first);
  });

  it('refuses paths outside the library', () => {
    const { likes } = setup();
    expect(() => likes.image('../studio/x.png')).toThrow();
    expect(() => likes.image('a/../../etc.png')).toThrow();
    expect(() => likes.image('nope/missing.png')).toThrow();
  });
});
