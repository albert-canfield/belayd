import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { version } from '../version.js';
import { contentHash, trustedHash } from './trust.js';
import { readRegularFile } from '../util/files.js';
import { ensurePrivateDir } from '../util/paths.js';
import type { Rule } from './schema.js';

export const POLICY_FILE = 'belayd.yaml';
export const DEFAULT_PRESET = 'balanced';

/** `project` holds the rules of a project file you have not trusted: they can only add. */
export type Layer = 'final' | 'user' | 'preset' | 'project';

export interface LayeredRule extends Rule {
  layer: Layer;
}

export interface CompiledPolicy {
  /** Human description, e.g. `balanced preset + ./belayd.yaml`. */
  name: string;
  preset: string;
  files: string[];
  default: 'pass' | 'ask' | 'allow';
  rules: {
    final: LayeredRule[];
    user: LayeredRule[];
    preset: LayeredRule[];
    project: LayeredRule[];
  };
  disabled: string[];
  approval: {
    timeoutMs: number;
    onTimeout: 'deny' | 'allow';
    /** native = the agent's own prompt; tty = `belayd approve`; web = the local page. */
    channels: ('native' | 'tty' | 'web' | 'dialog')[];
    notify: boolean;
    port: number;
  };
  failMode: 'closed' | 'open';
  snapshots: { enabled: boolean; maxFileSize: number };
  /** False when a project belayd.yaml has not been reviewed with `belayd trust`. */
  trusted: boolean;
  /** More folders that count as part of the project, absolute. */
  folders: string[];
  /** Things the user should know, such as ignored parts of an untrusted file. */
  warnings: string[];
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

/** Bump when the shape of CompiledPolicy changes, so old cache entries are not reused. */
const CACHE_FORMAT = 3;
const MAX_POLICY_BYTES = 1024 * 1024;

/**
 * Loads the policy for a workspace. Parsing YAML and validating it costs tens of
 * milliseconds, which matters when a hook runs on every tool call, so the compiled
 * result is cached under $BELAYD_HOME/cache, keyed by a hash of every input file.
 */
export async function loadPolicy(opts: LoadOptions): Promise<CompiledPolicy> {
  const file = opts.preset
    ? undefined
    : (opts.policyPath ?? findPolicyFile(opts.workspace, opts.belaydHome));

  // Your own file and a file you name explicitly are trusted. A belayd.yaml inside the
  // project is trusted only after `belayd trust`, pinned to its exact content, and it
  // builds on your own file rather than replacing it.
  const globalFile = path.join(opts.belaydHome, POLICY_FILE);
  const isProjectFile =
    !opts.policyPath && file !== undefined && path.resolve(file) !== path.resolve(globalFile);
  const baseFile = isProjectFile && fs.existsSync(globalFile) ? globalFile : undefined;

  // Every file is read once: the trust check, the cache key and the compiler all see
  // the same bytes, so nothing can swap the file in between.
  const text = file ? readPolicyText(file) : undefined;
  const baseText = baseFile ? readPolicyText(baseFile) : undefined;
  const trusted = !isProjectFile || trustedHash(opts.belaydHome, file!) === contentHash(text ?? '');

  const key = opts.noCache
    ? undefined
    : cacheKey([
        String(CACHE_FORMAT),
        version,
        opts.preset ?? '',
        file ?? '',
        String(trusted),
        baseFile ?? '',
        text ?? '',
        baseText ?? '',
      ]);
  const cacheFile = key ? path.join(opts.belaydHome, 'cache', `policy-${key}.json`) : undefined;
  if (cacheFile) {
    try {
      return JSON.parse(fs.readFileSync(cacheFile, 'utf8')) as CompiledPolicy;
    } catch {
      // not cached yet
    }
  }

  const { compilePolicy } = await import('./compile.js');
  const policy = compilePolicy({
    ...(file ? { file: { file, text: text! } } : {}),
    ...(baseFile ? { base: { file: baseFile, text: baseText! } } : {}),
    ...(opts.preset ? { preset: opts.preset } : {}),
    trusted,
  });
  if (cacheFile) writeCache(cacheFile, policy);
  return policy;
}

/**
 * Reads a policy file, refusing anything that is not a regular file of sane size. A
 * repository can ship belayd.yaml as a named pipe or a link to /dev/zero, and a plain
 * read would then hang every hook call.
 */
export function readPolicyText(file: string): string {
  let read: { text: string; size: number };
  try {
    read = readRegularFile(file, MAX_POLICY_BYTES);
  } catch (err) {
    throw new PolicyError(`cannot read the policy file (${(err as Error).message})`, file);
  }
  if (read.size > MAX_POLICY_BYTES)
    throw new PolicyError('the policy file is larger than 1 MB', file);
  return read.text;
}

function cacheKey(parts: string[]): string | undefined {
  try {
    const hash = crypto.createHash('sha256');
    for (const part of parts) hash.update(`${part.length}:`).update(part);
    const dir = presetsDir();
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.endsWith('.yaml')) hash.update(name).update(fs.readFileSync(path.join(dir, name)));
    }
    return hash.digest('hex').slice(0, 24);
  } catch {
    return undefined; // compile without the cache and report the real error
  }
}

function writeCache(file: string, policy: CompiledPolicy): void {
  try {
    ensurePrivateDir(path.dirname(path.dirname(file)));
    ensurePrivateDir(path.dirname(file));
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
