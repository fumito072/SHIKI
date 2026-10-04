// The user's ♥ across all Studio projects, kept as plain files: library/likes/<project>/<item>.png + .json.
// The folder mirrors the ratings (♥ adds, un-♥ removes) and outlives the projects, so it is the thing to back up or sync.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import type { Store } from './store';
import type { Item, Project } from './types';

export interface LikeEntry {
  project: string;
  projectTitle: string;
  item: string;
  title: string;
  stage: 'look' | 'motion';
  engine: Item['engine'];
  prompt: string;
  motion?: string;
  note: string;
  likedAt: number;
  /** Path inside the library, `<project>/<item>.png`. */
  file: string;
}

const SAFE = /^[a-z0-9][a-z0-9-]{0,40}$/;

export class Likes {
  readonly dir: string;
  constructor(private readonly store: Store, dir = process.env.SHIKI_LIBRARY_DIR) {
    this.dir = resolve(dir || join(store.root, 'library', 'likes'));
  }

  private paths(project: string, item: string) {
    if (!SAFE.test(project) || !/^[a-z0-9-]{1,64}$/.test(item)) throw new Error('Invalid like id');
    const base = join(this.dir, project, item);
    return { png: `${base}.png`, json: `${base}.json` };
  }

  /** Mirrors one item: copies the image and its story when it is ♥, removes them otherwise. */
  sync(p: Project, item: Item) {
    const { png, json } = this.paths(p.id, item.id);
    if (item.rating !== 1 || item.status !== 'done' || !item.file) {
      rmSync(png, { force: true });
      rmSync(json, { force: true });
      return;
    }
    const source = this.store.file(p.id, item.file);
    if (!existsSync(source)) return;
    const stage = item.id.startsWith('motion') ? 'motion' : 'look';
    let likedAt = Date.now();
    try {
      likedAt = (JSON.parse(readFileSync(json, 'utf8')) as LikeEntry).likedAt ?? likedAt;
    } catch {
      /* first like */
    }
    mkdirSync(join(this.dir, p.id), { recursive: true });
    if (!existsSync(png)) copyFileSync(source, png);
    const entry: LikeEntry = {
      project: p.id, projectTitle: p.title, item: item.id, title: item.title, stage, engine: item.engine,
      prompt: item.prompt, motion: item.motion, note: item.note, likedAt, file: `${p.id}/${item.id}.png`,
    };
    writeFileSync(json, JSON.stringify(entry, null, 2));
  }

  /** Brings the library in line with every project (run at start-up; also backfills likes made before it existed). */
  syncAll() {
    for (const { id } of this.store.list()) {
      const p = this.store.get(id);
      for (const r of p.rounds) for (const item of r.items) this.sync(p, item);
    }
  }

  list(): LikeEntry[] {
    if (!existsSync(this.dir)) return [];
    const out: LikeEntry[] = [];
    for (const project of readdirSync(this.dir)) {
      if (!SAFE.test(project)) continue;
      for (const f of readdirSync(join(this.dir, project))) {
        if (!f.endsWith('.json')) continue;
        try {
          const e = JSON.parse(readFileSync(join(this.dir, project, f), 'utf8')) as LikeEntry;
          if (existsSync(join(this.dir, e.file))) out.push(e);
        } catch {
          /* skip a broken sidecar */
        }
      }
    }
    return out.sort((a, b) => b.likedAt - a.likedAt);
  }

  /** Absolute path of a library image, refusing anything outside the library. */
  image(path: unknown): string {
    if (typeof path !== 'string' || !/^[a-z0-9][a-z0-9-]{0,40}\/[a-z0-9-]{1,64}\.png$/.test(path)) throw new Error('Invalid path');
    const file = resolve(this.dir, path);
    if (!file.startsWith(this.dir + sep) || !existsSync(file)) throw new Error('Not found');
    return file;
  }
}
