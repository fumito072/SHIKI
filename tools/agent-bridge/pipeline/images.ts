import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { agentEnv } from './agents';
import type { Job } from './types';

export function gptImageArgs(root: string, images: string[]) {
  return ['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-C', root, '-c', 'model_reasoning_effort=low', '--json', ...images.flatMap(image => ['-i', image]), '-'];
}
export function gptImagePrompt(prompt: string, target: string, motion: boolean) {
  return [
    'Use your built-in image generation tool (gpt-image) exactly once to create ONE image, size 1536x1024. Do not build code, run other agents, or start a server.',
    'Compose a landscape 16:9 VJ image within that canvas. No text, captions or labels.',
    motion
      ? [
          'MOTION STUDY. The first attached image is the chosen key visual: keep its scene, material, palette and light identical.',
          'The still must read as motion over time. Unless the prompt asks for a long or multiple exposure, compose it as a horizontal triptych: three equal panels left to right, separated by thin black gutters — (1) calm, (2) build / anticipation, (3) the drop / release — the same scene in each, only the state of the motion changes.',
          'Show the motion itself (displacement, trails, compression, inversion), not a pretty variation of the key visual.',
        ].join('\n')
      : 'Use attached references and liked images as creative guidance.',
    prompt,
    `Save or copy the generated image as PNG to this exact absolute path: ${target}. Edit only this output file.`,
    'Final reply: saved path only.',
  ].join('\n');
}
const claimed = new Set<string>();
export async function generateGpt(job: Job, root: string, prompt: string, target: string, images: string[], motion: boolean) {
  const start = Date.now();
  job.abort.signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const proc = spawn('codex', gptImageArgs(root, images), { cwd: root, env: agentEnv(), detached: true, stdio: ['pipe', 'ignore', 'pipe'] });
    job.procs.add(proc);
    let tail = '';
    proc.stderr?.on('data', (b: Buffer) => { tail = (tail + b.toString()).slice(-1000); });
    proc.stdin?.end(gptImagePrompt(prompt, target, motion));
    proc.on('error', reject);
    proc.on('close', code => {
      job.procs.delete(proc);
      if (job.abort.signal.aborted) reject(new Error('Cancelled'));
      else if (code !== 0) reject(new Error(`GPT Image exit ${code}: ${tail}`));
      else resolve();
    });
  });
  job.abort.signal.throwIfAborted();
  if (!existsSync(target)) {
    const dir = join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'generated_images');
    const newest = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.png')).map(f => join(dir, f)).filter(f => !claimed.has(f) && statSync(f).isFile() && statSync(f).mtimeMs >= start).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0] : undefined;
    if (!newest) throw new Error('GPT Image did not save an image; no new generated_images PNG found');
    claimed.add(newest); copyFileSync(newest, target);
  }
  if (!statSync(target).isFile() || !readFileSync(target).subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) throw new Error('GPT Image output is not PNG');
}
