import { describe, it, expect } from 'bun:test';
import { DEFAULT_TIER_MATCH, classifyTier, resolveTierMatch } from '../src/providers/tier-match.js';

const base = resolveTierMatch(undefined);

describe('tier smart match (providers/tier-match)', () => {
  it('classifies name-keyword models as fast (incl. haiku)', () => {
    expect(classifyTier({ modelId: 'gemini-2.5-flash', reasoningFlag: false }, base)).toBe('fast');
    expect(classifyTier({ modelId: 'gpt-4o-mini', reasoningFlag: false }, base)).toBe('fast');
    expect(classifyTier({ modelId: 'claude-haiku-4-5', reasoningFlag: false }, base)).toBe('fast');
  });

  it('includes free/local models (input = 0) in the fast band', () => {
    expect(classifyTier({ modelId: 'qwen3-32b', inputPerM: 0, reasoningFlag: false }, base)).toBe('fast');
  });

  it('excludes models WITHOUT pricing from bands (no synthesized price)', () => {
    expect(classifyTier({ modelId: 'some-unknown-model', inputPerM: undefined, reasoningFlag: false }, base)).toBe('flagship');
  });

  it('reasoning flag beats mid price', () => {
    expect(classifyTier({ modelId: 'kimi-k2', inputPerM: 1, reasoningFlag: true }, base)).toBe('reasoning');
  });

  it('price >= 5 is reasoning, mid price falls back to flagship', () => {
    expect(classifyTier({ modelId: 'claude-sonnet-5', inputPerM: 15, reasoningFlag: false }, base)).toBe('reasoning');
    expect(classifyTier({ modelId: 'gpt-5.2', inputPerM: 2.5, reasoningFlag: false }, base)).toBe('flagship');
  });

  it('user match overrides defaults per field', () => {
    const custom = resolveTierMatch({ fast: { match: { maxInputPerM: 1.2 } }, reasoning: { match: { patterns: ['*qwq*'] } } });
    expect(classifyTier({ modelId: 'glm-4-air', inputPerM: 1.0, reasoningFlag: false }, custom)).toBe('fast');
    expect(classifyTier({ modelId: 'qwq-32b', inputPerM: 0.5, reasoningFlag: false }, custom)).toBe('reasoning');
    // fast patterns default kept because only maxInputPerM was replaced
    expect(custom.fast.patterns).toEqual(DEFAULT_TIER_MATCH.fast.patterns);
  });

  it('explicit flagship patterns pin a model', () => {
    const custom = resolveTierMatch({ flagship: { match: { patterns: ['*sonnet*'] } } });
    expect(classifyTier({ modelId: 'claude-sonnet-5', inputPerM: 15, reasoningFlag: true }, custom)).toBe('flagship');
  });
});
