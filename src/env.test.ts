import { describe, expect, it } from 'vitest';

import { normalizeAnthropicModel } from './env.js';

describe('normalizeAnthropicModel', () => {
  it('maps unsupported Claude Sonnet aliases to sonnet', () => {
    expect(normalizeAnthropicModel('claude-sonnet-4-6')).toBe('sonnet');
    expect(normalizeAnthropicModel('anthropic/claude-4-sonnet')).toBe('sonnet');
  });

  it('maps unsupported Claude Opus/Haiku aliases to shorthand', () => {
    expect(normalizeAnthropicModel('claude-opus-4-1')).toBe('opus');
    expect(normalizeAnthropicModel('claude-3-5-haiku')).toBe('haiku');
  });

  it('preserves already supported shorthands and third-party model ids', () => {
    expect(normalizeAnthropicModel('sonnet')).toBe('sonnet');
    expect(normalizeAnthropicModel('gpt-5.4')).toBe('gpt-5.4');
    expect(normalizeAnthropicModel('')).toBeUndefined();
  });
});
