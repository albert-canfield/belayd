import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { formatIssues, PolicySchema, type PolicyFile, type Rule } from './schema.js';

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
    channels: ('native' | 'tty' | 'web')[];
  };
  failMode: 'closed' | 'open';
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
}

/** Finds the policy for a workspace: ./belayd.yaml, then $BELAYD_HOME/belayd.yaml, then the default preset. */
export function findPolicyFile(workspace: string, belaydHome: string): string | undefined {
  for (const candidate of [path.join(workspace, POLICY_FILE), path.join(belaydHome, POLICY_FILE)]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

export function loadPolicy(opts: LoadOptions): CompiledPolicy {
  if (opts.preset) return compile(undefined, undefined, opts.preset);
  const file = opts.policyPath ?? findPolicyFile(opts.workspace, opts.belaydHome);
  if (!file) return compile(undefined, undefined, DEFAULT_PRESET);
  const user = readPolicyFile(file);
  return compile(user, file, user.extends ?? DEFAULT_PRESET);
}

export function readPolicyFile(file: string): PolicyFile {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    throw new PolicyError(`cannot read the policy file (${(err as Error).message})`, file);
  }
  return parsePolicy(text, file);
}

export function parsePolicy(text: string, file?: string): PolicyFile {
  let data: unknown;
  try {
    data = parseYaml(text);
  } catch (err) {
    throw new PolicyError(`not valid YAML: ${(err as Error).message}`, file);
  }
  const result = PolicySchema.safeParse(data ?? {});
  if (!result.success) throw new PolicyError(`invalid policy\n${formatIssues(result.error)}`, file);
  return result.data;
}

function compile(
  user: PolicyFile | undefined,
  userFile: string | undefined,
  presetName: string,
): CompiledPolicy {
  const chain = presetName === 'none' ? [] : loadPresetChain(presetName);
  const presetRules = new Map<string, Rule>();
  let defaultVerdict: CompiledPolicy['default'] = 'pass';
  const disabled = new Set<string>();
  let approval: PolicyFile['approval'] = {};
  let failMode: PolicyFile['failMode'];
  for (const p of chain) {
    for (const r of p.rules) presetRules.set(r.id, r);
    for (const id of p.disable) presetRules.delete(id);
    if (p.default) defaultVerdict = p.default;
    approval = { ...approval, ...p.approval };
    failMode = p.failMode ?? failMode;
  }

  if (user) {
    if (user.default) defaultVerdict = user.default;
    for (const id of user.disable) {
      if (!presetRules.has(id)) {
        throw new PolicyError(
          `disable: there is no rule "${id}" in the ${presetName} preset`,
          userFile,
        );
      }
      disabled.add(id);
    }
    approval = { ...approval, ...user.approval };
    failMode = user.failMode ?? failMode;
    const seen = new Set<string>();
    for (const r of user.rules) {
      if (seen.has(r.id)) throw new PolicyError(`rule id "${r.id}" is used twice`, userFile);
      seen.add(r.id);
      if (r.final)
        throw new PolicyError(`rule "${r.id}": only presets can mark rules as final`, userFile);
    }
  }

  const active = [...presetRules.values()].filter((r) => !disabled.has(r.id));
  return {
    name: userFile ? `${presetName} preset + ${userFile}` : `${presetName} preset`,
    preset: presetName,
    files: userFile ? [userFile] : [],
    default: defaultVerdict,
    rules: {
      final: active.filter((r) => r.final).map((r) => ({ ...r, layer: 'final' })),
      user: (user?.rules ?? []).map((r) => ({ ...r, layer: 'user' })),
      preset: active.filter((r) => !r.final).map((r) => ({ ...r, layer: 'preset' })),
    },
    disabled: [...disabled],
    approval: {
      timeoutMs: toMs(approval?.timeout ?? '120s'),
      onTimeout: approval?.onTimeout ?? 'deny',
      channels: approval?.channels ?? ['native', 'web'],
    },
    failMode: failMode ?? 'closed',
  };
}

/** A preset and the presets it extends, base first. */
function loadPresetChain(name: string, seen: string[] = []): PolicyFile[] {
  if (seen.includes(name))
    throw new PolicyError(`presets extend each other in a loop: ${[...seen, name].join(' -> ')}`);
  const file = path.join(presetsDir(), `${name}.yaml`);
  if (!fs.existsSync(file)) {
    throw new PolicyError(`unknown preset "${name}". Available: ${listPresets().join(', ')}`);
  }
  const preset = readPolicyFile(file);
  const parent = preset.extends ? loadPresetChain(preset.extends, [...seen, name]) : [];
  return [...parent, preset];
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

function toMs(v: number | string): number {
  if (typeof v === 'number') return v * 1000;
  const m = /^(\d+)(ms|s|m)$/.exec(v)!;
  const n = Number(m[1]);
  return m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : n * 60_000;
}
