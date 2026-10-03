import { describe, expect, it } from 'vitest';
import { gptImageArgs, gptImagePrompt } from './images';
import { agentEnv } from './agents';

describe('GPT Image CLI contract', () => {
  it('uses the subscription CLI, low effort, workspace sandbox and ordered image arguments', () => {
    expect(gptImageArgs('/repo', ['/repo/key visual.png', '/repo/study.png'])).toEqual(['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-C', '/repo', '-c', 'model_reasoning_effort=low', '--json', '-i', '/repo/key visual.png', '-i', '/repo/study.png', '-']);
    expect(gptImagePrompt('motion brief', '/repo/studio/test/motion/r1-01.png', true)).toContain('exactly once');
    expect(gptImagePrompt('motion brief', '/repo/file.png', true)).toContain('1536x1024');
    expect(gptImagePrompt('motion brief', '/repo/file.png', true)).toContain('first attached image');
    expect(gptImagePrompt('motion brief', '/repo/file.png', true)).toContain('/repo/file.png');
  });
  it('strips API credentials and parent session markers while retaining CLI config', () => {
    const original = { ...process.env };
    try {
      Object.assign(process.env, { OPENAI_API_KEY: 'test', OPENAI_BASE_URL: 'test', ANTHROPIC_API_KEY: 'test', ANTHROPIC_BASE_URL: 'test', CLAUDECODE: '1', CLAUDE_CONFIG_DIR: '/config' });
      const env = agentEnv();
      expect(env.OPENAI_API_KEY).toBeUndefined(); expect(env.OPENAI_BASE_URL).toBeUndefined();
      expect(env.ANTHROPIC_API_KEY).toBeUndefined(); expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
      expect(env.CLAUDECODE).toBeUndefined(); expect(env.CLAUDE_CONFIG_DIR).toBe('/config');
    } finally { process.env = original; }
  });
});
