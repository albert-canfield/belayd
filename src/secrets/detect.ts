import fs from 'node:fs';
import path from 'node:path';

export interface SecretMatch {
  /** Detector id, e.g. `github-token`, or `env:STRIPE_KEY` for a value from a workspace .env file. */
  id: string;
  /** The matched text, for redaction only. Never print it. */
  value: string;
}

const DETECTORS: { id: string; re: RegExp }[] = [
  { id: 'aws-access-key', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/g },
  { id: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{60,255}\b/g },
  { id: 'gitlab-token', re: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { id: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g },
  { id: 'slack-webhook', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/g },
  { id: 'stripe-key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/g },
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  {
    id: 'openai-key',
    re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{20,}|\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/g,
  },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/g },
  { id: 'private-key', re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g },
  { id: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
];

/** Values shorter than this are too likely to appear by accident. */
const MIN_ENV_VALUE_LENGTH = 12;
const BORING_VALUES =
  /^(true|false|null|undefined|localhost|development|production|test|staging)$/i;
const ENV_FILE = /^\.env(\..+)?$/;
const ENV_EXAMPLE = /\.(example|sample|template|dist)$/;

export function findSecrets(
  text: string,
  envValues: Map<string, string> = new Map(),
): SecretMatch[] {
  const found: SecretMatch[] = [];
  for (const { id, re } of DETECTORS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) found.push({ id, value: m[0] });
  }
  for (const [name, value] of envValues) {
    if (text.includes(value)) found.push({ id: `env:${name}`, value });
  }
  return found;
}

/** Replaces anything that looks like a secret with a placeholder naming the detector. */
export function redact(text: string, envValues?: Map<string, string>): string {
  let out = text;
  for (const s of findSecrets(text, envValues)) out = out.split(s.value).join(`[redacted:${s.id}]`);
  return out;
}

/** Reads `.env` style files at the top of the workspace and returns values worth watching for. */
export function loadEnvValues(workspace: string): Map<string, string> {
  const values = new Map<string, string>();
  let entries: string[];
  try {
    entries = fs.readdirSync(workspace);
  } catch {
    return values;
  }
  for (const name of entries) {
    if (!ENV_FILE.test(name) || ENV_EXAMPLE.test(name)) continue;
    let content: string;
    try {
      content = fs.readFileSync(path.join(workspace, name), 'utf8');
    } catch {
      continue;
    }
    for (const line of content.split(/\r?\n/)) {
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
      if (!m) continue;
      let value = m[2]!.trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      } else {
        value = value.replace(/\s+#.*$/, '');
      }
      if (value.length >= MIN_ENV_VALUE_LENGTH && !BORING_VALUES.test(value))
        values.set(m[1]!, value);
    }
  }
  return values;
}
