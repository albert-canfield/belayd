import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { version } from '../version.js';
import type { Rule } from './schema.js';

export const POLICY_FILE = 'belayd.yaml';
export const DEFAULT_PRESET = 'balanced';

export type Layer = 'final' | 'user' | 'preset';

export interface LayeredRule extends Rule {
  layer: Layer;
}

export interface CompiledPolicy {
  /** Human description, e.g. `balanced preset + ./belayd.yaml`. */
  name: string;
  preset: string;
  files: string[];
  default: 'pass' | 'ask' | 'allow';
  rules: { final: LayeredRule[]; user: LayeredRule[]; preset: LayeredRule[] };
  disabled: string[];
  approval: {
    timeoutMs: number;
    onTimeout: 'deny' | 'allow';
    /** native = the agent's own prompt; tty = `belayd approve`; web = the local page. */
    channels: ('native' | 'tty' | 'web')[];
    notify: boolean;
    port: number;
  };
  failMode: 'closed' | 'open';
  snapshots: { enabled: boolean; maxFileSize: number };
}

export class PolicyError extends Error {
  constructor(
    message: string,
    readonly file?: string,
  ) {
    super(file ? `${file}: ${message}` : message);
  }
}

export interface LoadOptions {
  workspace: string;
  belaydHome: string;
  /** Explicit policy file. Skips discovery. */
  policyPath?: string;
  /** Use this preset and ignore policy files. */
  preset?: string;
  /** Skip the compiled-policy cache (tests, `belayd doctor`). */
  noCache?: boolean;
}

/** Finds the policy for a workspace: ./belayd.yaml, then $BELAYD_HOME/belayd.yaml, then the default preset. */
export function findPolicyFile(workspace: string, belaydHome: string): string | undefined {
  for (const candidate of [path.join(workspace, POLICY_FILE), path.join(belaydHome, POLICY_FILE)]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

/**
 * Loads the policy for a workspace. Parsing YAML and validating it costs tens of
 * milliseconds, which matters when a hook runs on every tool call, so the compiled
 * result is cached under $BELAYD_HOME/cache, keyed by a hash of every input file.
 */
export async function loadPolicy(opts: LoadOptions): Promise<CompiledPolicy> {
  const file = opts.preset
    ? undefined
    : (opts.policyPath ?? findPolicyFile(opts.workspace, opts.belaydHome));

  const key = opts.noCache ? undefined : cacheKey(file, opts.preset);
  const cacheFile = key ? path.join(opts.belaydHome, 'cache', `policy-${key}.json`) : undefined;
  if (cacheFile) {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as CompiledPolicy;
    } catch {
      // not cached yet
    }
  }

  const { compileFromFile } = await import('./compile.js');
  const policy = compileFromFile(file, opts.preset);
  if (cacheFile) writeCache(cacheFile, policy);
  return policy;
}

function cacheKey(file: string | undefined, preset: string | undefined): string | undefined {
  try {
    const hash = crypto.createHash('sha256');
    hash.update(`${version}\0${preset ?? ''}\0${file ?? ''}\0`);
    if (file) hash.update(fs.readFileSync(file));
    const dir = presetsDir();
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.endsWith('.yaml')) hash.update(name).update(fs.readFileSync(path.join(dir, name)));
    }
    return hash.digest('hex').slice(0, 24);
  } catch {
    return undefined; // unreadable file: compile without the cache and report the real error
  }
}

function writeCache(file: string, policy: CompiledPolicy): void {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(policy));
    fs.renameSync(tmp, file);
  } catch {
    // a read-only BELAYD_HOME only costs speed, never correctness
  }
}

export function listPresets(): string[] {
  return fs
    .readdirSync(presetsDir())
    .filter((f) => f.endsWith('.yaml'))
    .map((f) => f.replace(/\.yaml$/, ''))
    .sort();
}

let cachedPresetsDir: string | undefined;

/** The `presets/` folder shipped with the package, found from this file's location. */
export function presetsDir(): string {
  if (cachedPresetsDir) return cachedPresetsDir;
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 5; i++) {
    const candidate = path.join(dir, 'presets');
    if (fs.existsSync(path.join(candidate, `${DEFAULT_PRESET}.yaml`)))
      return (cachedPresetsDir = candidate);
    dir = path.dirname(dir);
  }
  throw new PolicyError('cannot find the presets folder. Is the belayd installation complete?');
}
