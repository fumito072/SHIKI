import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import type { Item, Project } from './types';

export class InputError extends Error { constructor(message: string, public status = 400) { super(message); } }
export const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
export function projectId(value: unknown): string {
  if (typeof value !== 'string' || !ID.test(value)) throw new InputError('Invalid project id');
  return value;
}
export function stringInput(value: unknown, name: string, max = 100000, empty = false): string {
  if (typeof value !== 'string' || value.length > max || (!empty && !value.trim())) throw new InputError(`Invalid ${name}`);
  return value;
}

export function safePath(base: string, path: unknown): string {
  if (typeof path !== 'string' || !path || path.includes('\\') || path.includes('\0') || path.split('/').some(p => !p || p === '.' || p === '..') || path.startsWith('/')) throw new InputError('Unsafe path');
  const root = resolve(base), target = resolve(root, path);
  if (!target.startsWith(root + sep)) throw new InputError('Unsafe path');
  // Reject symlinks, including a symlinked storage root.
  let cursor = target;
  while (true) {
    try { if (lstatSync(cursor).isSymbolicLink()) throw new InputError('Symlink path refused'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    if (cursor === root) break;
    cursor = dirname(cursor);
  }
  if (existsSync(target) && !realpathSync(target).startsWith(realpathSync(root) + sep)) throw new InputError('Unsafe path');
  return target;
}

export const imageTypes: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
export function decodeRef(value: unknown) {
  if (typeof value !== 'string' || value.length > 12 * 1024 * 1024) throw new InputError('Reference data URL exceeds 12 MB');
  const m = /^data:image\/(png|jpeg|webp|gif);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!m || m[2].length % 4 !== 0) throw new InputError('Invalid image data URL');
  const bytes = Buffer.from(m[2], 'base64');
  if (bytes.toString('base64') !== m[2]) throw new InputError('Invalid base64');
  const valid = m[1] === 'png' ? bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    : m[1] === 'jpeg' ? bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
    : m[1] === 'gif' ? /^GIF8[79]a/.test(bytes.subarray(0, 6).toString())
    : bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WEBP';
  if (!valid) throw new InputError('Image bytes do not match content type');
  return { bytes, ext: m[1] === 'jpeg' ? 'jpg' : m[1] };
}

export class Store {
  constructor(public root: string) {}
  dir(id: unknown) { return safePath(this.root, `studio/${projectId(id)}`); }
  file(id: unknown, path: unknown) { return safePath(this.dir(id), path); }
  get(id: unknown): Project {
    const path = this.file(id, 'project.json');
    if (!existsSync(path)) throw new InputError('Unknown project', 404);
    const project = JSON.parse(readFileSync(path, 'utf8')) as Project;
    project.models ??= [];
    return project;
  }
  save(project: Project) {
    project.updated = Date.now();
    const file = this.file(project.id, 'project.json');
    mkdirSync(dirname(file), { recursive: true });
    const temp = this.file(project.id, 'project.json.tmp');
    writeFileSync(temp, JSON.stringify(project, null, 2));
    renameSync(temp, file);
    return project;
  }
  list() {
    const dir = safePath(this.root, 'studio');
    if (!existsSync(dir)) return [];
    return readdirSync(dir).filter(id => ID.test(id)).map(id => {
      const p = this.get(id), items = p.rounds.flatMap(r => r.items);
      const cover = items.find(i => i.id === p.keyVisual)?.file ?? [...items].reverse().find(i => i.file)?.file;
      return { id, title: p.title, stage: p.stage, updated: p.updated, cover: cover ? `/__shiki/studio/file?id=${id}&path=${encodeURIComponent(cover)}` : null };
    }).sort((a, b) => b.updated - a.updated);
  }
  create(title: unknown, brief: unknown, refs: unknown = [], slug?: unknown) {
    const t = stringInput(title, 'title', 500), b = stringInput(brief, 'brief');
    const images = this.validateRefs(refs, 0);
    // An explicit slug wins (Japanese titles do not romanise); it becomes the work's folder name.
    const wanted = typeof slug === 'string' ? slug.trim().toLowerCase() : '';
    const stem = (ID.test(wanted) ? wanted.slice(0, 32) : '') || t.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || `project-${createHash('sha256').update(t).digest('hex').slice(0, 8)}`;
    let id = stem, n = 2;
    while (existsSync(this.dir(id)) || existsSync(join(this.root, 'works', id))) { const suffix = `-${n++}`; id = `${stem.slice(0, 41 - suffix.length)}${suffix}`; }
    const now = Date.now();
    const p: Project = { id, title: t, brief: b, refs: [], stage: 'look', rounds: [], keyVisual: null, studies: [], workId: null, models: [], created: now, updated: now };
    this.writeRefs(p, images);
    return this.save(p);
  }
  update(id: unknown, title: unknown, brief: unknown) {
    const p = this.get(id);
    if (title !== undefined) p.title = stringInput(title, 'title', 500);
    if (brief !== undefined) p.brief = stringInput(brief, 'brief');
    return this.save(p);
  }
  validateRefs(refs: unknown, existing: number) {
    if (!Array.isArray(refs) || refs.length + existing > 8) throw new InputError('At most 8 references');
    return refs.map(decodeRef);
  }
  private writeRefs(p: Project, images: ReturnType<typeof decodeRef>[]) {
    let n = 1;
    for (const image of images) {
      let file: string;
      do { file = `refs/${String(n++).padStart(2, '0')}.${image.ext}`; }
      while (Object.keys(imageTypes).some(ext => existsSync(this.file(p.id, file.replace(/\.[^.]+$/, ext)))));
      mkdirSync(dirname(this.file(p.id, file)), { recursive: true });
      writeFileSync(this.file(p.id, file), image.bytes); p.refs.push(file);
    }
  }
  addRefs(id: unknown, refs: unknown) { const p = this.get(id); this.writeRefs(p, this.validateRefs(refs, p.refs.length)); return this.save(p); }
  removeRef(id: unknown, path: unknown) {
    const p = this.get(id); this.file(id, path);
    if (typeof path !== 'string' || !p.refs.includes(path)) throw new InputError('Unknown reference');
    p.refs = p.refs.filter(ref => ref !== path); rmSync(this.file(id, path)); return this.save(p);
  }
  item(p: Project, id: unknown, stage?: 'look' | 'motion'): Item {
    const item = p.rounds.filter(r => !stage || r.stage === stage).flatMap(r => r.items).find(i => i.id === id);
    if (!item) throw new InputError('Unknown item');
    return item;
  }
  rate(id: unknown, item: unknown, rating: unknown, note: unknown) {
    const p = this.get(id), i = this.item(p, item);
    if (rating !== -1 && rating !== 0 && rating !== 1) throw new InputError('Invalid rating');
    if (note !== undefined) i.note = stringInput(note, 'note', 10000, true);
    i.rating = rating; return this.save(p);
  }
  choose(id: unknown, keyVisual: unknown, studies: unknown) {
    const p = this.get(id);
    if ((keyVisual === undefined) === (studies === undefined)) throw new InputError('Choose keyVisual or studies');
    const done = (item: Item) => { if (item.status !== 'done' || !item.file || !existsSync(this.file(id, item.file))) throw new InputError('Image is not ready'); };
    if (keyVisual !== undefined) {
      done(this.item(p, keyVisual, 'look'));
      p.keyVisual = keyVisual as string; p.studies = []; p.stage = 'motion'; p.workId = null;
    } else {
      if (!p.keyVisual || !Array.isArray(studies) || !studies.length || new Set(studies).size !== studies.length) throw new InputError('Invalid studies');
      for (const item of studies) done(this.item(p, item, 'motion'));
      p.studies = studies; p.stage = 'motion'; p.workId = null;
    }
    return this.save(p);
  }
  /**
   * Items left queued/running by a dev-server restart (the job died with the old server): done if the image landed,
   * otherwise marked as interrupted so the UI does not wait forever.
   */
  recover() {
    for (const { id } of this.list()) {
      const p = this.get(id);
      let changed = false;
      for (const r of p.rounds) r.items.forEach((item, k) => {
        if (item.status !== 'running' && item.status !== 'queued') return;
        const file = `${r.stage}/r${r.n}-${String(k + 1).padStart(2, '0')}.png`;
        if (existsSync(this.file(id, file))) Object.assign(item, { status: 'done', file });
        else Object.assign(item, { status: 'error', error: '中断されました（開発サーバーの再起動）。もう一度ラウンドを作ってください。' });
        changed = true;
      });
      if (p.stage === 'build' && !p.workId) changed = true;
      if (changed) this.save(p);
    }
  }
  image(id: unknown, path: unknown) {
    const file = this.file(id, path);
    const type = imageTypes[extname(file).toLowerCase()];
    if (!type) throw new InputError('Image files only');
    if (!existsSync(file) || !lstatSync(file).isFile()) throw new InputError('Image not found', 404);
    return { file, type };
  }
  asset(id: unknown, path: unknown) {
    if (typeof path !== 'string' || extname(path).toLowerCase() !== '.glb') return this.image(id, path);
    const file = this.file(id, path);
    if (!existsSync(file) || !lstatSync(file).isFile()) throw new InputError('Model not found', 404);
    return { file, type: 'model/gltf-binary' };
  }
}
