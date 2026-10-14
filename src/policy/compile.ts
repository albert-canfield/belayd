import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  DEFAULT_PRESET,
  listPresets,
  PolicyError,
  presetsDir,
  type CompiledPolicy,
} from './load.js';
import { DEFAULT_PORT } from '../approval/ui-state.js';
import { formatIssues, PolicySchema, type PolicyFile, type Rule } from './schema.js';

/**
 * The slow half of policy loading: YAML parsing and validation. The hook only
 * reaches this when the policy changed since the last call (see load.ts).
 */

export function compileFromFile(
  file: string | undefined,
  preset: string | undefined,
): CompiledPolicy {
  if (!file) return compile(undefined, undefined, preset ?? DEFAULT_PRESET);
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

export function compile(
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
  let snapshots: PolicyFile['snapshots'] = {};
  for (const p of chain) {
    for (const r of p.rules) presetRules.set(r.id, r);
    for (const id of p.disable) presetRules.delete(id);
    if (p.default) defaultVerdict = p.default;
    approval = { ...approval, ...p.approval };
    failMode = p.failMode ?? failMode;
    snapshots = { ...snapshots, ...p.snapshots };
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
    snapshots = { ...snapshots, ...user.snapshots };
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
      channels: approval?.channels ?? ['native', 'tty', 'web'],
      notify: approval?.notify ?? true,
      port: approval?.port ?? DEFAULT_PORT,
    },
    failMode: failMode ?? 'closed',
    snapshots: {
      enabled: snapshots?.enabled ?? true,
      maxFileSize: toBytes(snapshots?.maxFileSize ?? '20MB'),
    },
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

function toMs(v: number | string): number {
  if (typeof v === 'number') return v * 1000;
  const m = /^(\d+)(ms|s|m)$/.exec(v)!;
  const n = Number(m[1]);
  return m[2] === 'ms' ? n : m[2] === 's' ? n * 1000 : n * 60_000;
}

function toBytes(v: number | string): number {
  if (typeof v === 'number') return v;
  const m = /^(\d+)(KB|MB|GB)$/i.exec(v)!;
  const unit = m[2]!.toUpperCase();
  return Number(m[1]) * (unit === 'KB' ? 1024 : unit === 'MB' ? 1024 ** 2 : 1024 ** 3);
}
