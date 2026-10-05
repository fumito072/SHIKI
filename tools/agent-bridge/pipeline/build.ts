import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { Job, Project } from './types';
import { Store, InputError, safePath } from './store';

export function buildInputs(store: Store, project: Project) {
  if (!project.keyVisual || !project.studies.length) throw new InputError('Build requires a key visual and at least one motion study');
  const key = store.item(project, project.keyVisual, 'look');
  const studies = project.studies.map(id => store.item(project, id, 'motion'));
  for (const item of [key, ...studies]) {
    if (item.status !== 'done' || !item.file) throw new InputError('Selected image is not ready');
    store.image(project.id, item.file);
  }
  return { key, studies };
}

function convert(job: Job, source: string, target: string): Promise<void> {
  job.abort.signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const proc = spawn('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '85', '-Z', '1920', source, '--out', target], { detached: true, stdio: ['ignore', 'ignore', 'pipe'] });
    job.procs.add(proc);
    let error = '';
    proc.stderr?.on('data', (chunk: Buffer) => { error = (error + chunk.toString()).slice(-1000); });
    proc.on('error', reject);
    proc.on('close', code => {
      job.procs.delete(proc);
      if (job.abort.signal.aborted) reject(new Error('Cancelled'));
      else if (code !== 0 || !existsSync(target)) reject(new Error(`sips conversion failed (${code}): ${error}`));
      else resolve();
    });
  });
}

/** Starts a new work from works/_starter (WebGPU plumbing); an existing index.ts is left for the agent to rewrite. */
function starter(root: string, dest: string, id: string): 'new' | 'gpu' | 'legacy' {
  const target = safePath(dest, 'index.ts');
  if (existsSync(target)) return /defineGpuInstrument/.test(readFileSync(target, 'utf8')) ? 'gpu' : 'legacy';
  const code = readFileSync(safePath(root, 'works/_starter/index.ts'), 'utf8')
    .replace(/id: 'starter',[^\n]*/, `id: '${id}',`);
  writeFileSync(target, code);
  return 'new';
}

/** Copies the project's Meshy models (animated > rigged > static) into works/<id>/models/. */
function copyModels(store: Store, project: Project, dest: string): string[] {
  const out: string[] = [];
  for (const m of project.models ?? []) {
    const src = m.anim ?? m.rigged ?? m.file;
    const from = store.file(project.id, src);
    if (!existsSync(from)) continue;
    const name = `models/${basename(src)}`;
    mkdirSync(dirname(safePath(dest, name)), { recursive: true });
    copyFileSync(from, safePath(dest, name));
    out.push(`${name}${m.anim ? ' (rigged, with dance clips)' : m.rigged ? ' (rigged)' : ''}`);
  }
  return out;
}

export async function prepareBuild(store: Store, project: Project, job: Job) {
  const { key, studies } = buildInputs(store, project);
  const dest = safePath(store.root, `works/${project.id}`);
  mkdirSync(dest, { recursive: true });
  const start = starter(store.root, dest, project.id);
  const models = copyModels(store, project, dest);
  const images = [safePath(dest, 'keyvisual.jpg'), ...studies.map((_, n) => safePath(dest, `studies/${String(n + 1).padStart(2, '0')}.jpg`))];
  for (let n = 0; n < images.length; n++) {
    mkdirSync(dirname(images[n]), { recursive: true });
    await convert(job, store.file(project.id, [key, ...studies][n].file!), images[n]);
  }
  const markdown = studies.map((item, n) => `## ${String(n + 1).padStart(2, '0')}. ${item.title}\n\n${item.motion ?? ''}\n\n${item.prompt}\n`).join('\n');
  writeFileSync(safePath(dest, 'studies.md'), markdown);
  job.message = [project.brief,
    `Build a WebGPU world (AGENTS.md → "WebGPU worlds") from the approved key visual and chosen motion studies in works/${project.id}/studies.md (inlined below).`,
    start === 'legacy'
      ? `works/${project.id}/index.ts is an older WebGL (GLSL) version: rewrite it as a WebGPU world, starting from the plumbing in works/_starter/index.ts, and delete the shader files it no longer uses.`
      : `works/${project.id}/index.ts already holds the WebGPU plumbing (signals → Director → camera → makePost → the deck's target, light as events): keep the plumbing, replace the placeholder world, set name / nameJa / mood / macros.`,
    'The experience is more than the image: build a space with a camera and editing — the Director cuts on bars, holds a push through a build, hits the drop with a new look; light comes as events (kicks, onsets, the drop), never as a constant glow. works/alien-signal shows how (borrow its editing and lighting, not its look).',
    'A still frame must still read like the key visual. Use the image itself as material: `keyImage(kv)` + `coverUv` (src/engine/gpu/image.ts) sampled in TSL nodes — displace it into relief, slice it into shards, scatter it into compute particles that carry its colours, project it onto geometry, decompose it by luminance into layers. Do not redraw it from scratch with noise.',
    models.length ? `3D models made for this project (Meshy) are in the work folder: ${models.join(', ')}. Load them with GLTFLoader (\`import url from './models/<file>?url'\`), clone rigged ones with SkeletonUtils.clone, drive dance clips by beats (see works/alien-signal).` : '',
    'Motion follows the studies (each study image is a calm → build → drop triptych or an exposure of the motion), mapped to kick / tension / drop / beat; preserve inertia, anticipation, stillness and prediction error. Keep all images in the folder.',
    `Use exactly work id ${project.id}.\n${markdown}`,
  ].filter(Boolean).join('\n\n');
  return images;
}
