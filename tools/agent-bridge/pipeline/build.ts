import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
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

export async function prepareBuild(store: Store, project: Project, job: Job) {
  const { key, studies } = buildInputs(store, project);
  const dest = safePath(store.root, `works/${project.id}`);
  const images = [safePath(dest, 'keyvisual.jpg'), ...studies.map((_, n) => safePath(dest, `studies/${String(n + 1).padStart(2, '0')}.jpg`))];
  for (let n = 0; n < images.length; n++) {
    mkdirSync(dirname(images[n]), { recursive: true });
    await convert(job, store.file(project.id, [key, ...studies][n].file!), images[n]);
  }
  const markdown = studies.map((item, n) => `## ${String(n + 1).padStart(2, '0')}. ${item.title}\n\n${item.motion ?? ''}\n\n${item.prompt}\n`).join('\n');
  writeFileSync(safePath(dest, 'studies.md'), markdown);
  job.message = [project.brief,
    `Build the instrument from the approved key visual and chosen motion studies in works/${project.id}/studies.md (inlined below).`,
    'A still frame must read like the key visual. Use the image itself as the material: `import kv from \'./keyvisual.jpg\'` + `imageTexture` (src/engine/assets.ts) and `#include <shiki_image>` / `coverUv` — sample, displace, slice, decompose by luminance into layers or particles, feed it through feedback. Declare the image uniforms in the shader yourself (uniform sampler2D uKey; uniform vec2 uKeySize;). Do not redraw it from scratch with noise.',
    'Motion follows the studies (each study image is a calm → build → drop triptych or an exposure of the motion), mapped to kick / tension / drop / beat; preserve inertia, anticipation, stillness and prediction error. Keep all images in the folder.',
    `Use exactly work id ${project.id}.\n${markdown}`,
  ].join('\n\n');
  return images;
}
