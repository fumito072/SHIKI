import type { InstrumentModule } from '../engine/types';

export interface LoadResult {
  works: InstrumentModule[];
  /** Key visual URL per work folder (works/<id>/keyvisual.jpg|png), used as the library thumbnail. */
  art: Record<string, string>;
  /** Works that failed to load (syntax error, missing file …). The rest keep running. */
  errors: { id: string; error: string }[];
}

type Listener = (result: LoadResult) => void;

const loaders = import.meta.glob<{ default: InstrumentModule }>('../../works/*/index.ts');
const artUrls = import.meta.glob<string>('../../works/*/keyvisual.{jpg,png}', { eager: true, query: '?url', import: 'default' });

/** Loads every work in works/<id>/ independently (folders starting with "_" are skipped), sorted by name. */
export async function loadWorks(): Promise<LoadResult> {
  const entries = Object.entries(loaders).filter(([path]) => !/\/works\/_/.test(path));
  const settled = await Promise.allSettled(entries.map(([, load]) => load()));
  const works: InstrumentModule[] = [];
  const errors: LoadResult['errors'] = [];
  settled.forEach((r, i) => {
    const id = entries[i][0].replace(/^.*\/works\/([^/]+)\/index\.ts$/, '$1');
    if (r.status === 'fulfilled' && r.value?.default?.manifest) works.push(r.value.default);
    else errors.push({ id, error: r.status === 'rejected' ? String(r.reason) : 'no default export' });
  });
  works.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  const art: Record<string, string> = {};
  for (const [path, url] of Object.entries(artUrls)) art[path.replace(/^.*\/works\/([^/]+)\/keyvisual\.\w+$/, '$1')] = url;
  return { works, errors, art };
}

// Listeners survive hot updates of this module through hot.data.
const listeners: Set<Listener> = import.meta.hot?.data.listeners ?? new Set<Listener>();
if (import.meta.hot) import.meta.hot.data.listeners = listeners;

/** Called with a fresh load whenever a work's code or shader changes (Vite HMR). */
export function onWorksChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

if (import.meta.hot) {
  import.meta.hot.accept((next) => {
    const load = (next as { loadWorks?: () => Promise<LoadResult> } | undefined)?.loadWorks;
    if (load) void load().then((res) => listeners.forEach((fn) => fn(res)));
  });
}
