import path from 'node:path';
import { analyzeShell, programName, resolveIn, type Invocation } from './shell.js';
import type { Action, ActionContext, ActionKind } from './types.js';

/**
 * A subject is one thing policy rules are matched against: a whole read, write or fetch,
 * or a single program inside a shell command.
 */
export interface Subject {
  kind: ActionKind;
  toolName: string | undefined;
  /** What to show a person: the command text, a path or a URL. */
  label: string;
  program: string | undefined;
  argv: string[];
  /** Arguments after argv[0], with combined short flags split (`-rf` also gives `-r`, `-f`). */
  args: string[];
  /** Positional arguments, skipping option values for programs we know (git -C, -c). */
  positionals: string[];
  /** Absolute paths touched in any way. */
  paths: string[];
  reads: string[];
  writes: string[];
  domains: string[];
  /** Text leaving the machine, scanned for secrets. */
  outbound: string[];
  codeFrom: string[];
  dynamic: boolean;
  unresolved: boolean;
  inlineCode: boolean;
  remote: boolean;
  parseError: boolean;
  via: string[];
  note: string | undefined;
}

const NETWORK_SENDERS = new Set([
  'curl',
  'wget',
  'http',
  'https',
  'xh',
  'nc',
  'ncat',
  'netcat',
  'socat',
  'telnet',
  'ssh',
  'scp',
  'sftp',
  'ftp',
  'rsync',
  'aws',
  'gcloud',
  'az',
  'gh',
]);

const OPTION_VALUES: Record<string, Set<string>> = {
  git: new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']),
};

/** Programs whose first positional argument is not a path (a pattern, a script, text). */
const FIRST_POSITIONAL_NOT_PATH = new Set([
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ack',
  'sed',
  'awk',
  'gawk',
  'jq',
  'git',
]);
const NO_PATHS = new Set([
  'echo',
  'printf',
  'true',
  'false',
  'test',
  '[',
  'export',
  'alias',
  'unalias',
  'kill',
  'sleep',
  'seq',
]);

/** Programs that change every path argument they get. */
const WRITES_ALL = new Set([
  'rm',
  'rmdir',
  'unlink',
  'shred',
  'srm',
  'rimraf',
  'truncate',
  'touch',
  'mkdir',
  'tee',
  'mv',
  'chattr',
  'setfacl',
]);
/** Programs whose first positional is a mode or owner, and change the rest. */
const WRITES_AFTER_FIRST = new Set(['chmod', 'chown', 'chgrp']);
/** Programs that change only their last path argument (the destination). */
const WRITES_LAST = new Set(['cp', 'install', 'ln', 'rsync', 'scp']);

const SPECIAL_FILES = /^\/dev\/(null|zero|stdout|stderr|stdin|tty|fd\/\d+|random|urandom)$/;
const GLOB_CHARS = /[*?[]/;

export function buildSubjects(action: Action, ctx: ActionContext): Subject[] {
  switch (action.kind) {
    case 'shell': {
      const analysis = analyzeShell(action.command, {
        cwd: ctx.cwd,
        home: ctx.home,
        env: safeEnv(),
      });
      const subjects = analysis.invocations.map((inv) => fromInvocation(inv, ctx));
      if (analysis.errors.length > 0) {
        subjects.push({
          ...empty('shell', ctx, action.command),
          parseError: true,
          note: `belayd could not fully parse this command (${analysis.errors[0]})`,
        });
      }
      return subjects;
    }
    case 'read': {
      const p = absolute(action.path, ctx);
      return [{ ...empty('read', ctx, action.path), paths: [p], reads: [p] }];
    }
    case 'write': {
      const p = absolute(action.path, ctx);
      return [{ ...empty('write', ctx, action.path), paths: [p], writes: [p] }];
    }
    case 'fetch':
      return [
        {
          ...empty('fetch', ctx, action.url),
          domains: domainsIn(action.url),
          outbound: [action.url, action.body ?? ''].filter(Boolean),
        },
      ];
    case 'mcp': {
      const json = safeJson(action.args);
      return [
        {
          ...empty('mcp', ctx, `${action.server}: ${action.tool}`),
          domains: domainsIn(json),
          outbound: [json],
        },
      ];
    }
    case 'tool':
      return [empty('tool', ctx, action.name)];
  }
}

function fromInvocation(inv: Invocation, ctx: ActionContext): Subject {
  const program = inv.program || undefined;
  const raw = inv.argv.slice(1);
  const args: string[] = [];
  for (const a of raw) {
    args.push(a);
    if (/^-[A-Za-z]{2,}$/.test(a)) for (const ch of a.slice(1)) args.push(`-${ch}`);
    const eq = /^(--[^=]+)=/.exec(a);
    if (eq) args.push(eq[1]!);
  }

  const optionValues = (program && OPTION_VALUES[program]) || new Set<string>();
  const positionals: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    const a = raw[i]!;
    if (optionValues.has(a)) {
      i++;
      continue;
    }
    if (a === '--') {
      positionals.push(...raw.slice(i + 1));
      break;
    }
    if (!a.startsWith('-') || a === '-') positionals.push(a);
  }

  let unresolved = inv.unresolved;
  const resolve = (p: string): string[] => {
    if (SPECIAL_FILES.test(p)) return [];
    const out: string[] = [];
    const full = inv.remote && !p.startsWith('/') ? undefined : resolveIn(inv.cwd, p, ctx.home);
    if (full === undefined) {
      unresolved = true;
      return out;
    }
    out.push(full);
    // `rm -rf /*` deletes everything in `/`, so the folder before the first glob counts too.
    const glob = full.search(GLOB_CHARS);
    if (glob >= 0) out.push(path.dirname(full.slice(0, glob + 1)));
    return out;
  };

  const candidates = pathCandidates(program, positionals, raw);
  const paths = new Set<string>();
  const writes = new Set<string>();
  const explicitReads = new Set<string>();
  for (const c of candidates) for (const p of resolve(c)) paths.add(p);

  if (program) {
    const pathArgs = candidates;
    if (WRITES_ALL.has(program)) pathArgs.forEach((c) => resolve(c).forEach((p) => writes.add(p)));
    if (WRITES_AFTER_FIRST.has(program))
      pathArgs.slice(1).forEach((c) => resolve(c).forEach((p) => writes.add(p)));
    if (WRITES_LAST.has(program) && pathArgs.length > 1)
      resolve(pathArgs[pathArgs.length - 1]!).forEach((p) => writes.add(p));
    if (
      (program === 'sed' || program === 'perl') &&
      args.some((a) => a === '-i' || a.startsWith('-i') || a === '--in-place')
    ) {
      pathArgs.forEach((c) => resolve(c).forEach((p) => writes.add(p)));
    }
    if (program === 'dd') {
      for (const a of raw)
        if (a.startsWith('of=')) resolve(a.slice(3)).forEach((p) => (writes.add(p), paths.add(p)));
      for (const a of raw)
        if (a.startsWith('if='))
          resolve(a.slice(3)).forEach((p) => (explicitReads.add(p), paths.add(p)));
    }
    for (let i = 0; i < raw.length; i++) {
      const a = raw[i]!;
      if (
        (program === 'curl' && (a === '-o' || a === '--output')) ||
        (program === 'wget' && (a === '-O' || a === '--output-document'))
      ) {
        const target = raw[i + 1];
        if (target && target !== '-') resolve(target).forEach((p) => (writes.add(p), paths.add(p)));
      }
    }
  }

  for (const r of inv.redirects) {
    if (!r.resolved) {
      unresolved = true;
      continue;
    }
    const resolved = resolve(r.target);
    resolved.forEach((p) => paths.add(p));
    if (r.op.includes('>')) resolved.forEach((p) => writes.add(p));
    else resolved.forEach((p) => explicitReads.add(p));
  }

  const reads = new Set([...paths].filter((p) => !writes.has(p) || program === 'mv'));
  explicitReads.forEach((p) => reads.add(p));

  const domains = new Set<string>();
  for (const a of raw) for (const d of domainsIn(a)) domains.add(d);
  if (
    program === 'ssh' ||
    program === 'scp' ||
    program === 'sftp' ||
    program === 'rsync' ||
    program === 'git'
  ) {
    for (const a of positionals) {
      const m = /^(?:[^@\s/]+@)?([A-Za-z0-9.-]+\.[A-Za-z]{2,}|[A-Za-z0-9-]+):/.exec(a);
      if (m && !/^[a-z]+:\/\//i.test(a)) domains.add(m[1]!.toLowerCase());
    }
    if (program === 'ssh' && positionals[0] && !positionals[0].includes(':')) {
      domains.add(positionals[0].replace(/^[^@]+@/, '').toLowerCase());
    }
  }

  const outbound: string[] = [];
  if (program && NETWORK_SENDERS.has(program)) {
    outbound.push(inv.argv.join(' '));
    if (inv.stdin) outbound.push(inv.stdin);
  }

  return {
    kind: 'shell',
    toolName: ctx.toolName,
    label: inv.text,
    program,
    argv: inv.argv,
    args,
    positionals,
    paths: [...paths],
    reads: [...reads],
    writes: [...writes],
    domains: [...domains],
    outbound,
    codeFrom: inv.codeFrom,
    dynamic: inv.dynamic,
    unresolved,
    inlineCode: inv.inlineCode,
    remote: inv.remote,
    parseError: false,
    via: inv.via,
    note: inv.note,
  };
}

function pathCandidates(
  program: string | undefined,
  positionals: string[],
  raw: string[],
): string[] {
  if (!program || NO_PATHS.has(program)) return [];
  let list = positionals;
  if (FIRST_POSITIONAL_NOT_PATH.has(program)) {
    const explicitPattern = raw.some((a) =>
      ['-e', '-f', '--regexp', '--file', '--expression'].includes(a),
    );
    if (!explicitPattern || program === 'git') list = positionals.slice(1);
  }
  return list.filter((p) => p !== '' && p !== '-' && !/^[a-z][a-z0-9+.-]*:\/\//i.test(p));
}

export function domainsIn(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(
    /\b[a-z][a-z0-9+.-]*:\/\/(?:[^/\s:@"']+(?::[^/\s@"']*)?@)?([^/\s:?#"'`)]+)/gi,
  )) {
    out.push(m[1]!.toLowerCase().replace(/\.$/, ''));
  }
  return out;
}

function absolute(p: string, ctx: ActionContext): string {
  return resolveIn(ctx.cwd, p, ctx.home) ?? path.resolve(ctx.cwd, p);
}

function empty(kind: ActionKind, ctx: ActionContext, label: string): Subject {
  return {
    kind,
    toolName: ctx.toolName,
    label,
    program: undefined,
    argv: [],
    args: [],
    positionals: [],
    paths: [],
    reads: [],
    writes: [],
    domains: [],
    outbound: [],
    codeFrom: [],
    dynamic: false,
    unresolved: false,
    inlineCode: false,
    remote: false,
    parseError: false,
    via: [],
    note: undefined,
  };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}

/** Only non-secret environment values are used to resolve `$VAR` in commands. */
function safeEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['USER', 'LOGNAME', 'TMPDIR', 'SHELL']) {
    const v = process.env[name];
    if (v) env[name] = v;
  }
  return env;
}

export { programName };
