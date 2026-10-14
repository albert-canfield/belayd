import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  DEFAULT_PRESET,
  listPresets,
  PolicyError,
  presetsDir,
  readPolicyText,
  type CompiledPolicy,
  type LayeredRule,
} from './load.js';
import { DEFAULT_PORT } from '../approval/ui-state.js';
import { formatIssues, PolicySchema, type PolicyFile, type Rule } from './schema.js';

/**
 * The slow half of policy loading: YAML parsing and validation. The hook only
 * reaches this when the policy changed since the last call (see load.ts).
 */

export interface PolicySource {
  file: string;
  text: string;
}

export interface CompileInput {
  /** The policy file that applies: a project's belayd.yaml, your own, or one named explicitly. */
  file?: PolicySource;
  /** Your own policy ($BELAYD_HOME/belayd.yaml), which a project file builds on. */
  base?: PolicySource;
  /** False for a project file you have not reviewed with `belayd trust`. */
  trusted: boolean;
  /** Use this preset and no files. */
  preset?: string;
}

const STRICTNESS: Record<string, number> = {
  none: -1,
  'yolo-with-undo': 0,
  balanced: 1,
  strict: 2,
};
const DEFAULT_ORDER: Record<string, number> = { allow: 0, pass: 1, ask: 2 };
const DEFAULT_TIMEOUT = '120s';

export function compilePolicy(input: CompileInput): CompiledPolicy {
  if (!input.file) return compile(undefined, undefined, input.preset ?? DEFAULT_PRESET);
  const file = input.file.file;
  const user = parsePolicy(input.file.text, file);
  const base = input.base ? parsePolicy(input.base.text, input.base.file) : undefined;
  if (!input.trusted) return compileUntrusted(user, file, base, input.base?.file);
  if (!base || !input.base) return compile(user, file, user.extends ?? DEFAULT_PRESET);

  // A trusted project file builds on your own policy: your rules still apply inside the
  // project, and the project's settings win where both set one. A project rule with the
  // same id as one of yours replaces it.
  const ids = new Set(user.rules.map((r) => r.id));
  const merged: PolicyFile = {
    ...base,
    ...user,
    rules: [...base.rules.filter((r) => !ids.has(r.id)), ...user.rules],
    disable: [...new Set([...base.disable, ...user.disable])],
    approval: { ...base.approval, ...user.approval },
    snapshots: { ...base.snapshots, ...user.snapshots },
  };
  const extendsName = user.extends ?? base.extends ?? DEFAULT_PRESET;
  const compiled = compile(merged, file, extendsName, new Set(base.disable));
  return {
    ...compiled,
    name: `${compiled.preset} preset + ${input.base.file} + ${file}`,
    files: [file, input.base.file],
  };
}

/**
 * An untrusted project file can only make belayd stricter. Its deny and ask rules are
 * checked after your own policy and count only where they are stricter than its
 * verdict. Allow rules, disable, weaker presets and defaults, approval settings other
 * than a shorter timeout, failMode and snapshot settings are ignored, and said so.
 */
function compileUntrusted(
  user: PolicyFile,
  file: string,
  base: PolicyFile | undefined,
  baseFile: string | undefined,
): CompiledPolicy {
  const ignored: string[] = [];
  const baseExtends = base?.extends ?? DEFAULT_PRESET;
  let extendsName = baseExtends;
  if (user.extends && user.extends !== baseExtends) {
    if ((STRICTNESS[user.extends] ?? -1) > (STRICTNESS[baseExtends] ?? 99))
      extendsName = user.extends;
    else ignored.push(`extends: ${user.extends}`);
  }
  const presetChain = (name: string) => (name === 'none' ? [] : loadPresetChain(name));
  const chain = presetChain(extendsName);
  const presetDefault = chain.reduce<string>((d, p) => p.default ?? d, 'pass');
  const effective = base?.default ?? presetDefault;
  let defaultVerdict = base?.default;
  if (user.default) {
    if ((DEFAULT_ORDER[user.default] ?? 0) > (DEFAULT_ORDER[effective] ?? 0))
      defaultVerdict = user.default;
    else if (user.default !== effective) ignored.push(`default: ${user.default}`);
  }
  const allows = user.rules.filter((r) => r.decision === 'allow');
  if (allows.length > 0)
    ignored.push(`${allows.length} allow rule${allows.length === 1 ? '' : 's'}`);
  if (user.disable.length > 0) ignored.push(`disable: [${user.disable.join(', ')}]`);
  if (user.failMode === 'open') ignored.push('failMode: open');
  if (user.snapshots) ignored.push('snapshots settings');

  // Approval settings decide who may answer and how; only a shorter wait is accepted.
  const baseTimeout =
    base?.approval?.timeout ??
    chain.reduce<string | number | undefined>((t, p) => p.approval?.timeout ?? t, undefined) ??
    DEFAULT_TIMEOUT;
  let timeout: string | number | undefined;
  for (const [k, v] of Object.entries(user.approval ?? {})) {
    if (k === 'timeout' && toMs(v as string | number) < toMs(baseTimeout)) timeout = v as string;
    else ignored.push(`approval.${k}`);
  }

  const seen = new Set<string>();
  for (const r of user.rules) {
    if (seen.has(r.id)) throw new PolicyError(`rule id "${r.id}" is used twice`, file);
    seen.add(r.id);
    if (r.final)
      throw new PolicyError(`rule "${r.id}": only presets can mark rules as final`, file);
  }

  const restricted: PolicyFile = {
    ...(base ?? { version: 1, rules: [], disable: [] }),
    extends: extendsName,
    ...(defaultVerdict ? { default: defaultVerdict } : {}),
    ...(user.failMode === 'closed' ? { failMode: 'closed' as const } : {}),
    approval: { ...base?.approval, ...(timeout !== undefined ? { timeout } : {}) },
  };
  const compiled = compile(restricted, baseFile ?? file, extendsName, new Set(base?.disable ?? []));

  // A stricter preset brings its asks and denies, not its allow rules: `extends: strict`
  // must not turn `git log` from "the agent asks as usual" into a silent yes.
  let { final, preset } = compiled.rules;
  if (extendsName !== baseExtends) {
    const baseAllows = new Set(
      presetChain(baseExtends).flatMap((p) =>
        p.rules.filter((r) => r.decision === 'allow').map((r) => r.id),
      ),
    );
    const keep = (r: LayeredRule) => r.decision !== 'allow' || baseAllows.has(r.id);
    final = final.filter(keep);
    preset = preset.filter(keep);
  }
  return {
    ...compiled,
    name: `${compiled.preset} preset${baseFile ? ` + ${baseFile}` : ''} + ${file} (not trusted)`,
    files: [file, ...(baseFile ? [baseFile] : [])],
    rules: {
      ...compiled.rules,
      final,
      preset,
      project: user.rules
        .filter((r) => r.decision !== 'allow')
        .map((r) => ({ ...r, id: `project-${r.id}`, layer: 'project' })),
    },
    trusted: false,
    warnings: [
      `${file} is not trusted yet, so only its stricter rules apply.` +
        (ignored.length > 0 ? ` Ignored: ${ignored.join('; ')}.` : '') +
        ' Review it, then run: belayd trust',
    ],
  };
}

export function readPolicyFile(file: string): PolicyFile {
  return parsePolicy(readPolicyText(file), file);
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

/**
 * Builds the policy from a preset and one policy file. `optionalDisable` lists ids
 * from your own file that a project file may have moved past, by choosing another
 * preset; those are skipped when the preset has no such rule.
 */
export function compile(
  user: PolicyFile | undefined,
  userFile: string | undefined,
  presetName: string,
  optionalDisable: ReadonlySet<string> = new Set(),
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
        if (optionalDisable.has(id)) continue;
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
      project: [],
    },
    disabled: [...disabled],
    approval: {
      timeoutMs: toMs(approval?.timeout ?? DEFAULT_TIMEOUT),
      onTimeout: approval?.onTimeout ?? 'deny',
      channels: approval?.channels ?? ['native', 'tty', 'web'],
      notify: approval?.notify ?? true,
      port: approval?.port ?? DEFAULT_PORT,
    },
    failMode: failMode ?? 'closed',
    trusted: true,
    warnings: [],
    snapshots: {
      enabled: snapshots?.enabled ?? true,
      maxFileSize: toBytes(snapshots?.maxFileSize ?? '20MB'),
    },
  };
}

/** A preset and the presets it extends, base first. */
function loadPresetChain(name: string, seen: string[] = []): PolicyFile[] {
  if (!/^[a-z0-9-]+$/.test(name)) {
    throw new PolicyError(`unknown preset "${name}". Available: ${listPresets().join(', ')}`);
  }
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
