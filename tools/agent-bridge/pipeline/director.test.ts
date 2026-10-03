import { describe, expect, it } from 'vitest';
import { parseDirector, validateCounts, validateDirector } from './director';

const look = { notes: '余白を生かす', items: [{ engine: 'gpt-image', title: 'Quiet', prompt: 'a {curved} object with "reflection"' }, { engine: 'pinterest-lora', title: 'Roots', prompt: 'roots on black' }] };
const counts = { gpt: 1, lora: 1 };
describe('Director JSON', () => {
  it('takes the last fenced JSON, or the first balanced object with strings intact', () => {
    const json = JSON.stringify(look);
    expect(parseDirector(`draft\n\`\`\`json\n{}\n\`\`\`\nfinal\n\`\`\`JSON\n${json}\n\`\`\``, counts, 'look')).toEqual(look);
    expect(parseDirector(`Here is the direction: ${json}\nextra {}`, counts, 'look')).toEqual(look);
  });
  it('rejects malformed JSON, counts, engines and blank prompts with a clear message', () => {
    for (const json of ['nothing', '{', '```json\n{bad}\n```', JSON.stringify({ ...look, items: [] }), JSON.stringify({ ...look, items: [{ engine: 'other' }] }), JSON.stringify({ ...look, items: look.items.map(i => ({ ...i, prompt: '' })) })]) expect(() => parseDirector(json, counts, 'look')).toThrow('Invalid director JSON');
    expect(() => parseDirector(JSON.stringify(look), { gpt: 2, lora: 0 }, 'look')).toThrow('engine counts');
  });
  it('requires a Japanese motion explanation naming the driving signal', () => {
    const item = { engine: 'gpt-image', title: '逆行', prompt: 'a triptych', motion: 'tensionで凝集し、dropで混ざったものが戻る。時間の逆行を使う。' };
    expect(parseDirector(JSON.stringify({ notes: '動き', items: [item] }), { gpt: 1, lora: 0 }, 'motion').items[0]).toEqual(item);
    expect(() => parseDirector(JSON.stringify({ notes: '動き', items: [{ ...item, motion: undefined }] }), { gpt: 1, lora: 0 }, 'motion')).toThrow('motion');
    expect(() => parseDirector(JSON.stringify({ notes: '動き', items: [{ ...item, motion: 'ゆっくり動く' }] }), { gpt: 1, lora: 0 }, 'motion')).toThrow('kick');
  });
  it('validates director selection and 1–12 total counts including engine zeros', () => {
    expect(validateCounts(undefined, 'motion')).toEqual({ gpt: 10, lora: 0 });
    expect(validateCounts({ gpt: 0, lora: 12 }, 'look').lora).toBe(12);
    for (const c of [{ gpt: 0, lora: 0 }, { gpt: -1, lora: 3 }, { gpt: 1.5, lora: 0 }, { gpt: 12, lora: 1 }, { gpt: '1', lora: 0 }, null]) expect(() => validateCounts(c, 'look')).toThrow();
    expect(() => validateCounts(counts, 'motion')).toThrow('motion');
    expect(validateDirector({ agent: 'claude', model: 'claude-opus-5-5', effort: 'high' }).agent).toBe('claude');
    for (const d of [{ agent: 'x' }, { agent: 'codex', model: '-bad', effort: 'low' }, { agent: 'codex', model: 'model', effort: '--bad' }]) expect(() => validateDirector(d)).toThrow('Invalid director');
  });
});
