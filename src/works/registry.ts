import type { InstrumentModule } from '../engine/types';

type Listener = (works: InstrumentModule[]) => void;

const modules = import.meta.glob<{ default: InstrumentModule }>('../../works/*/index.ts', { eager: true });

/** Every work in works/<id>/ (folders starting with "_" are skipped), sorted by name. */
export const works: InstrumentModule[] = Object.entries(modules)
  .filter(([path]) => !/\/works\/_/.test(path))
  .map(([, m]) => m.default)
  .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));

export function findWork(id: string | null | undefined): InstrumentModule | undefined {
  return works.find((w) => w.manifest.id === id);
}

// Listeners survive hot updates of this module through hot.data.
const listeners: Set<Listener> = import.meta.hot?.data.listeners ?? new Set<Listener>();
if (import.meta.hot) import.meta.hot.data.listeners = listeners;

/** Called with the fresh list whenever a work's code or shader changes (Vite HMR). */
export function onWorksChanged(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

if (import.meta.hot) {
  import.meta.hot.accept((next) => {
    const fresh = (next as { works?: InstrumentModule[] } | undefined)?.works;
    if (fresh) for (const fn of listeners) fn(fresh);
  });
}
