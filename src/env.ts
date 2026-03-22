import fs from 'fs';
import path from 'path';
import YAML from 'yaml';
import { logger } from './logger.js';

const CLAUDE_MODEL_ALIAS_PATTERNS: Array<[RegExp, string]> = [
  [/^(?:anthropic\/)?claude-(?:3-7|4|4-\d+)?-?sonnet.*$/i, 'sonnet'],
  [/^(?:anthropic\/)?claude-(?:3|3-\d+|4|4-\d+)?-?opus.*$/i, 'opus'],
  [/^(?:anthropic\/)?claude-(?:3|3-\d+|4|4-\d+)?-?haiku.*$/i, 'haiku'],
];

/**
 * Parse the .env file and return values for the requested keys.
 * Does NOT load anything into process.env — callers decide what to
 * do with the values. This keeps secrets out of the process environment
 * so they don't leak to child processes.
 */
export function readEnvFile(keys: string[]): Record<string, string> {
  const envFile = path.join(process.cwd(), '.env');
  let content: string;
  try {
    content = fs.readFileSync(envFile, 'utf-8');
  } catch (err) {
    logger.debug({ err }, '.env file not found, using defaults');
    return {};
  }

  const result: Record<string, string> = {};
  const wanted = new Set(keys);

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    if (!wanted.has(key)) continue;
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (value) result[key] = value;
  }

  return result;
}

export function readSharedAiDefaultModel(): string | undefined {
  const configPath = path.resolve(
    process.cwd(),
    '..',
    'workspace',
    'config',
    'ai_config.yaml',
  );
  try {
    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = YAML.parse(raw) as {
      ai?: { default_model?: string };
    } | null;
    const modelId = parsed?.ai?.default_model?.trim();
    return modelId || undefined;
  } catch (err) {
    logger.debug({ err, configPath }, 'shared ai_config.yaml not available');
    return undefined;
  }
}

export function normalizeAnthropicModel(modelId?: string): string | undefined {
  const raw = modelId?.trim();
  if (!raw) return undefined;

  const lowered = raw.toLowerCase();
  if (lowered === 'sonnet' || lowered === 'opus' || lowered === 'haiku' || lowered === 'inherit') {
    return lowered;
  }

  for (const [pattern, normalized] of CLAUDE_MODEL_ALIAS_PATTERNS) {
    if (pattern.test(raw)) {
      logger.warn({ modelId: raw, normalized }, 'Normalizing unsupported Claude model alias');
      return normalized;
    }
  }

  return raw;
}
