import { createHash } from 'node:crypto';
import type { AgentId } from '../policy/types.js';
import { findSecrets, loadEnvValues, SECRET_HINT } from '../secrets/detect.js';
import { findWorkspace } from '../util/paths.js';

/**
 * Keys and tokens in agents' session history, for `belayd scan --secrets`. A secret is
 * known by its kind and a fingerprint: the first 8 hex digits of the SHA-256 of its value.
 * The value itself never leaves this file, not in a result and not in an error.
 */

/** Where in a transcript a secret turned up. */
export type Place = 'tool-output' | 'tool-input' | 'prompt' | 'assistant' | 'other';

export const PLACE_NAMES: Record<Place, string> = {
  'tool-output': 'tool output',
  'tool-input': 'tool input',
  prompt: 'user prompt',
  assistant: 'assistant text',
  other: 'other entries',
};

export interface FoundSecret {
  fingerprint: string;
  /** Detector ids, and `env:NAME` for a value from the project's .env. */
  kinds: string[];
  place: Place;
  /** The tool call it belongs to. Agents often store one output twice. */
  call?: string;
}

export interface SecretSighting extends FoundSecret {
  agent: AgentId;
  session: string;
  file: string;
  /** Epoch ms. */
  at: number;
  cwd: string;
}

const KIND_NAMES: Record<string, string> = {
  'aws-access-key': 'AWS access key',
  'github-token': 'GitHub token',
  'github-pat': 'GitHub token',
  'gitlab-token': 'GitLab token',
  'slack-token': 'Slack token',
  'slack-webhook': 'Slack webhook',
  'stripe-key': 'Stripe key',
  'anthropic-key': 'Anthropic API key',
  'openai-key': 'OpenAI API key',
  'google-api-key': 'Google API key',
  'npm-token': 'npm token',
  'private-key': 'Private key',
  jwt: 'JWT',
};

/** "GitHub token", or "value of STRIPE_KEY from .env" when it is a project's .env value. */
export function kindName(kinds: string[]): string {
  const env = kinds.filter((k) => k.startsWith('env:')).map((k) => k.slice(4));
  if (env.length > 0) return `value of ${env.join(' and ')} from .env`;
  return KIND_NAMES[kinds[0]!] ?? kinds[0]!;
}

const TOOL_INPUT = new Set([
  'tool_use',
  'server_tool_use',
  'function_call',
  'custom_tool_call',
  'local_shell_call',
  'exec_command_begin',
  'mcp_tool_call_begin',
]);
const TOOL_OUTPUT = new Set([
  'tool_result',
  'web_search_tool_result',
  'function_call_output',
  'custom_tool_call_output',
  'local_shell_call_output',
  'exec_command_end',
  'mcp_tool_call_end',
  'patch_apply_end',
]);
const THINKING = new Set(['thinking', 'reasoning', 'agent_reasoning']);
/** Codex events that repeat a response item stored next to them. */
const CODEX_MIRRORS = new Set([
  'user_message',
  'agent_message',
  'agent_reasoning',
  'agent_reasoning_raw_content',
]);
/** Encrypted or encoded blobs: nothing readable, and random text can look like a key. */
const SKIP_KEYS = new Set(['signature', 'encrypted_content']);
const ESCAPES = /\\[nrtfbv"'/\\]/g;

interface EnvSet {
  values: Map<string, string>;
  plain: string[];
  /** Each value as it can appear in a raw JSON line: as is, escaped once and twice. */
  raw: string[];
}

/** Names that are public by convention: frameworks ship these to the browser. */
const PUBLIC_NAME =
  /^(?:NEXT_PUBLIC|NUXT_PUBLIC|EXPO_PUBLIC|PUBLIC|VITE|REACT_APP|GATSBY|STORYBOOK)_/;
const SECRET_NAME =
  /KEY|TOKEN|SECRET|PASS|PWD|AUTH|CREDENTIAL|PRIVATE|SIGNING|SALT|DSN|WEBHOOK|COOKIE|SESSION/i;
/** `scheme://user:password@host`. */
const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^/\s@]*:[^/\s@]+@/i;

/**
 * The .env values worth reporting: ones whose name says they are secret, and URLs with a
 * password in them. A site URL or an app name in .env shows up in transcripts all the time.
 */
function envSet(all: Map<string, string>): EnvSet {
  const values = new Map<string, string>();
  for (const [name, value] of all) {
    if (PUBLIC_NAME.test(name)) continue;
    if (SECRET_NAME.test(name) || URL_WITH_PASSWORD.test(value)) values.set(name, value);
  }
  const raw = new Set<string>();
  for (const v of values.values()) {
    const once = JSON.stringify(v).slice(1, -1);
    raw.add(v).add(once).add(JSON.stringify(once).slice(1, -1));
  }
  return { values, plain: [...values.values()], raw: [...raw] };
}

/** A made-up key: AWS's documented example, or `ghp_xxxx...`. Real keys are random. */
function placeholder(value: string): boolean {
  return /example/i.test(value) || new Set(value).size < 10;
}

/**
 * The base64 body of a PEM private key that starts at `from`. The detector matches only the
 * header, which is the same for every key of a type.
 */
function keyBody(text: string, from: number): string {
  const end = text.indexOf('-----END', from);
  return (
    text
      .slice(from, end >= 0 ? end : from + 8192)
      // The Read tool puts a line number before each line.
      .replace(/^[ \t]*\d+(?:→|\t)/gm, '')
      .replace(/\\[nrt]/g, '')
      .replace(/[^A-Za-z0-9+/=]/g, '')
  );
}

export function fingerprint(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 8);
}

export class TranscriptSecrets {
  private byCwd = new Map<string, EnvSet>();
  private byWorkspace = new Map<string, EnvSet>();

  /** .env values of the project that `cwd` belongs to, read once per project. */
  private env(cwd: string): EnvSet {
    let set = this.byCwd.get(cwd);
    if (set) return set;
    let workspace = '';
    try {
      workspace = cwd ? findWorkspace(cwd) : '';
    } catch {
      // a folder we cannot look at has no .env for us either
    }
    set = this.byWorkspace.get(workspace);
    if (!set) {
      set = envSet(workspace ? loadEnvValues(workspace) : new Map());
      this.byWorkspace.set(workspace, set);
    }
    this.byCwd.set(cwd, set);
    return set;
  }

  /** A quick test on a raw history line. False means it holds nothing to report. */
  mayHold(line: string, cwd: string): boolean {
    if (SECRET_HINT.test(line)) return true;
    for (const r of this.env(cwd).raw) if (line.includes(r)) return true;
    return false;
  }

  /** Entries that only repeat others: Codex's events and compacted history. */
  repeats(entry: Record<string, unknown>): boolean {
    if (entry.type === 'compacted') return true;
    const payload = entry.payload as Record<string, unknown> | undefined;
    return entry.type === 'event_msg' && CODEX_MIRRORS.has(String(payload?.type));
  }

  /** The secrets in one parsed history entry, once per place. Never throws. */
  find(entry: unknown, cwd: string): FoundSecret[] {
    try {
      if (this.repeats(entry as Record<string, unknown>)) return [];
      const { values, plain } = this.env(cwd);
      const out = new Map<string, FoundSecret>();
      walk(entry, 'other', undefined, 0, (text, place, call) => {
        if (!SECRET_HINT.test(text) && !plain.some((v) => text.includes(v))) return;
        const matches = findSecrets(text, values);
        // A token right after an escaped newline (`\nghp_...`) has no word boundary.
        if (text.includes('\\')) matches.push(...findSecrets(text.replace(ESCAPES, ' ')));
        const keys = new Map<string, number>();
        for (const m of matches) {
          let value = m.value;
          if (m.id === 'private-key') {
            const at = text.indexOf(m.value, keys.get(m.value) ?? 0);
            if (at < 0) continue;
            keys.set(m.value, at + m.value.length);
            value = keyBody(text, at + m.value.length);
            if (value.length < 64) continue;
          } else if (m.id.startsWith('env:') ? new Set(value).size < 4 : placeholder(value)) {
            continue;
          }
          const fp = fingerprint(value);
          const key = `${fp}|${place}`;
          const seen = out.get(key);
          if (seen) {
            if (!seen.kinds.includes(m.id)) seen.kinds.push(m.id);
            if (!seen.call && call) seen.call = call;
          } else out.set(key, { fingerprint: fp, kinds: [m.id], place, ...(call ? { call } : {}) });
        }
      });
      return [...out.values()];
    } catch {
      // An error could carry a piece of the transcript. Report nothing for this entry instead.
      return [];
    }
  }
}

/** Calls `visit` with every readable string in an entry and where it sits. */
function walk(
  v: unknown,
  place: Place,
  call: string | undefined,
  depth: number,
  visit: (text: string, place: Place, call: string | undefined) => void,
): void {
  if (typeof v === 'string') {
    // Inline images and files.
    if (!(v.startsWith('data:') && v.includes(';base64,'))) visit(v, place, call);
    return;
  }
  if (depth > 64 || v === null || typeof v !== 'object') return;
  if (Array.isArray(v)) {
    for (const x of v) walk(x, place, call, depth + 1, visit);
    return;
  }
  const o = v as Record<string, unknown>;
  const type = typeof o.type === 'string' ? o.type : '';
  if (type === 'base64' || type === 'image') return;
  const id =
    typeof o.tool_use_id === 'string'
      ? o.tool_use_id
      : typeof o.call_id === 'string'
        ? o.call_id
        : type === 'tool_use' && typeof o.id === 'string'
          ? o.id
          : undefined;
  const here = placeOf(o, type, place);
  for (const [k, x] of Object.entries(o)) {
    if (SKIP_KEYS.has(k)) continue;
    walk(x, k === 'toolUseResult' ? 'tool-output' : here, id ?? call, depth + 1, visit);
  }
}

function placeOf(o: Record<string, unknown>, type: string, place: Place): Place {
  // Inside a tool call everything belongs to it, even text that looks like a message.
  if (place === 'tool-input' || place === 'tool-output') return place;
  if (TOOL_INPUT.has(type)) return 'tool-input';
  if (TOOL_OUTPUT.has(type)) return 'tool-output';
  if (THINKING.has(type)) return 'assistant';
  if (type === 'user_message') return 'prompt';
  // Claude Code's own notes and summaries, stored as user messages.
  if (o.isMeta === true || o.isCompactSummary === true) return 'other';
  // Claude Code names the speaker in `type`, Codex in `role`.
  const role = typeof o.role === 'string' ? o.role : type;
  if (role === 'user') return 'prompt';
  if (role === 'assistant') return 'assistant';
  if (role === 'developer' || role === 'system') return 'other';
  return place;
}

export interface TranscriptSeen {
  agent: AgentId;
  session: string;
  file: string;
  cwd: string;
  first: number;
  last: number;
  count: number;
}

export interface SecretSummary {
  fingerprint: string;
  kinds: string[];
  count: number;
  places: Partial<Record<Place, number>>;
  first: number;
  last: number;
  /** Most recent first. */
  transcripts: TranscriptSeen[];
}

/** Adds up sightings per secret, by fingerprint. */
export class SecretTally {
  private secrets = new Map<string, SecretSummary & { files: Map<string, TranscriptSeen> }>();

  add(s: SecretSighting): void {
    let g = this.secrets.get(s.fingerprint);
    if (!g) {
      g = {
        fingerprint: s.fingerprint,
        kinds: [],
        count: 0,
        places: {},
        first: s.at,
        last: s.at,
        transcripts: [],
        files: new Map(),
      };
      this.secrets.set(s.fingerprint, g);
    }
    for (const k of s.kinds) if (!g.kinds.includes(k)) g.kinds.push(k);
    g.count++;
    g.places[s.place] = (g.places[s.place] ?? 0) + 1;
    g.first = Math.min(g.first, s.at);
    g.last = Math.max(g.last, s.at);
    let t = g.files.get(s.file);
    if (!t) {
      t = {
        agent: s.agent,
        session: s.session,
        file: s.file,
        cwd: s.cwd,
        first: s.at,
        last: s.at,
        count: 0,
      };
      g.files.set(s.file, t);
    }
    t.count++;
    t.first = Math.min(t.first, s.at);
    t.last = Math.max(t.last, s.at);
  }

  get size(): number {
    return this.secrets.size;
  }

  /** Most recently seen first. */
  list(): SecretSummary[] {
    return [...this.secrets.values()]
      .map(({ files, ...g }) => ({
        ...g,
        kinds: [...g.kinds].sort(
          (a, b) => Number(b.startsWith('env:')) - Number(a.startsWith('env:')),
        ),
        transcripts: [...files.values()].sort((a, b) => b.last - a.last),
      }))
      .sort((a, b) => b.last - a.last);
  }
}
