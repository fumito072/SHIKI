import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { AgentId, AgentEvent, Job } from './types';

/**
 * Subscription login only: drop API keys / base URLs and the markers of a parent Claude Code session
 * (the dev server may itself have been started from one), keeping only where the CLI config lives.
 */
export function agentEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.OPENAI_API_KEY;
  delete env.OPENAI_BASE_URL;
  for (const k of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE)/.test(k) && k !== 'CLAUDE_CONFIG_DIR') delete env[k];
  return env;
}

export function spawnAgent(job: Pick<Job, 'agent' | 'model' | 'effort'>, text: string, root: string, images: string[] = [], readOnly = false): ChildProcess {
  const env = agentEnv();
  if (job.agent === 'claude') {
    // The prompt goes through stdin: no argv length limit, and stray control bytes cannot break the spawn.
    // Kept lean for speed: no MCP servers, skills or user-level plugins, only the tools the job needs, and the
    // ECC plugin's hooks on their minimal profile (its per-tool hooks and fact-forcing gate tripled run times).
    // Only affects these Studio runs, not the user's own Claude Code sessions.
    const args = [
      '-p',
      '--model', job.model,
      '--effort', job.effort,
      '--output-format', 'stream-json',
      '--verbose',
      '--permission-mode', 'acceptEdits',
      '--strict-mcp-config',
      '--disable-slash-commands',
      '--setting-sources', 'project,local',
      '--tools', ...(readOnly ? ['Read'] : ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash']),
      '--allowedTools', ...(readOnly ? ['Read'] : ['Read', 'Edit', 'Write', 'Glob', 'Grep',
      'Bash(npx tsc:*)', 'Bash(npm run typecheck:*)', 'Bash(npx vitest:*)', 'Bash(npm test:*)', 'Bash(ls:*)']),
    ];
    const p = spawn('claude', args, { cwd: root, env: { ...env, ECC_HOOK_PROFILE: 'minimal' }, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    p.stdin?.end(text);
    return p;
  }
  const args = ['exec', '--skip-git-repo-check', '-s', readOnly ? 'read-only' : 'workspace-write', '-C', root, '-m', job.model, '-c', `model_reasoning_effort=${job.effort}`, '--json'];
  for (const image of images) args.push('-i', image);
  args.push('-');
  const p = spawn('codex', args, { cwd: root, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  p.stdin?.end(text);
  return p;
}

/** Turns one JSON line from either CLI into display events. */
export function toEvents(agent: AgentId, o: Record<string, unknown>): Omit<AgentEvent, 'at'>[] {
  const out: Omit<AgentEvent, 'at'>[] = [];
  if (agent === 'claude') {
    if (o.type === 'assistant') {
      const content = ((o.message as { content?: unknown[] } | undefined)?.content ?? []) as Record<string, unknown>[];
      for (const c of content) {
        if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) out.push({ type: 'text', text: c.text.trim() });
        if (c.type === 'tool_use') {
          const input = (c.input ?? {}) as Record<string, unknown>;
          const what = (input.file_path ?? input.path ?? input.command ?? input.pattern ?? '') as string;
          out.push({ type: 'tool', text: `${String(c.name)} ${String(what).replace(/^.*\/shiki\//, '')}`.trim() });
        }
      }
    } else if (o.type === 'result') {
      if (o.is_error) out.push({ type: 'error', text: String(o.result ?? 'error') });
    }
    return out;
  }
  // codex --json
  const item = o.item as Record<string, unknown> | undefined;
  if (o.type === 'item.completed' && item) {
    if (item.type === 'agent_message' && typeof item.text === 'string') out.push({ type: 'text', text: item.text.trim() });
    else if (item.type === 'command_execution') out.push({ type: 'tool', text: `$ ${String(item.command ?? '')}`.slice(0, 200) });
    else if (item.type === 'file_change') {
      const changes = (item.changes as { path?: string }[] | undefined) ?? [];
      out.push({ type: 'tool', text: `edit ${changes.map((c) => String(c.path ?? '').replace(/^.*\/shiki\//, '')).join(', ')}` });
    } else if (item.type === 'reasoning' && typeof item.text === 'string') out.push({ type: 'status', text: item.text.trim().slice(0, 200) });
  } else if (o.type === 'error' || o.type === 'turn.failed') {
    out.push({ type: 'error', text: JSON.stringify(o.error ?? o.message ?? o).slice(0, 400) });
  }
  return out;
}

