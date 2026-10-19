import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import picomatch from 'picomatch';
import { canonicalPath } from '../util/paths.js';
import { readRegularFile } from '../util/files.js';
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
  /** Script files this subject runs. */
  runs: string[];
  /** Files whose contents decide what runs: package.json for `npm test`, the Makefile for `make`. */
  drivenBy: string[];
  dynamic: boolean;
  unresolved: boolean;
  inlineCode: boolean;
  remote: boolean;
  parseError: boolean;
  /**
   * Inside a committed, unchanged script the agent did not write: your own code. Only
   * rules that block apply there; questions fall back to the policy's default.
   */
  trusted: boolean;
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

/**
 * Options that take a value, per package manager. They differ: `-w` names a workspace
 * in npm but is a plain flag (`--workspace-root`) in pnpm and bun.
 */
const PACKAGE_MANAGER_OPTIONS: Record<string, Set<string>> = {
  npm: new Set(['--prefix', '-C', '-w', '--workspace']),
  pnpm: new Set(['-C', '--dir', '--filter', '-F']),
  yarn: new Set(['--cwd']),
  bun: new Set(['--cwd', '--filter']),
};
const OPTION_VALUES: Record<string, Set<string>> = {
  git: new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env']),
  ...PACKAGE_MANAGER_OPTIONS,
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
  'mkfifo',
  'mknod',
]);
/** Programs that look at names and metadata, never at what a file holds. */
const LISTS_ONLY = new Set([
  'ls',
  'stat',
  'du',
  'tree',
  'eza',
  'exa',
  'lsattr',
  'realpath',
  'readlink',
  'basename',
  'dirname',
  'cd',
  'pushd',
]);
/** Programs that read a file but print only a count, a checksum or its type. */
const NO_CONTENT = new Set([
  'wc',
  'file',
  'test',
  '[',
  'md5',
  'md5sum',
  'sha1sum',
  'sha256sum',
  'sha512sum',
  'shasum',
  'cksum',
  'b2sum',
]);

/**
 * True when a command touches files without ever printing what they hold: counts and
 * names (`grep -c`, `grep -l`, `grep -q`), the key names of a .env file (`cut -d= -f1`,
 * a sed that drops everything after `=`, `awk -F= '{print $1}'`) or Git bookkeeping
 * (`git check-ignore .env`). These are the careful ways to look at a secrets file.
 */
function showsNoContent(
  program: string | undefined,
  positionals: string[],
  raw: string[],
): boolean {
  if (!program) return false;
  if (NO_CONTENT.has(program)) return true;
  const flags = raw.filter((a) => a.startsWith('-'));
  const short = (letters: string) =>
    flags.some((f) => /^-[A-Za-z]+$/.test(f) && [...f.slice(1)].some((c) => letters.includes(c)));
  switch (program) {
    case 'git':
      return ['check-ignore', 'ls-files', 'check-attr'].includes(positionals[0] ?? '');
    case 'grep':
    case 'egrep':
    case 'fgrep':
    case 'rg':
      // A count, the names of matching files, or only the exit status.
      if (program === 'rg')
        return flags.some((f) =>
          /^(--count|--files-with-matches|--files-without-match|--quiet|-[cl]|-q)$/.test(f),
        );
      return (
        short('clLq') ||
        flags.some((f) => /^--(count|files-with-matches|files-without-match|quiet|silent)$/.test(f))
      );
    case 'cut': {
      // `cut -d= -f1`: the names before `=`.
      const d = raw.findIndex((a) => a === '-d' || a.startsWith('-d'));
      const delim = d < 0 ? undefined : raw[d] === '-d' ? raw[d + 1] : raw[d]!.slice(2);
      const f = raw.findIndex((a) => a === '-f' || a.startsWith('-f'));
      const fields = f < 0 ? undefined : raw[f] === '-f' ? raw[f + 1] : raw[f]!.slice(2);
      return delim === '=' && fields === '1';
    }
    case 'sed': {
      // A sed that drops everything after `=` prints the names only; never in place.
      if (flags.some((f) => f.startsWith('-i') || f === '--in-place')) return false;
      const script = raw.find((a) => !a.startsWith('-'));
      return script !== undefined && /^s([/|#])=\.\*\$?\1\1p?$/.test(script);
    }
    case 'awk':
    case 'gawk':
    case 'mawk': {
      const fs = raw.findIndex((a) => a === '-F' || a.startsWith('-F'));
      const sep = fs < 0 ? undefined : raw[fs] === '-F' ? raw[fs + 1] : raw[fs]!.slice(2);
      const prog = raw.find((a, i) => !a.startsWith('-') && raw[i - 1] !== '-F');
      return sep === '=' && prog !== undefined && /^\{\s*print\s+\$1\s*\}$/.test(prog);
    }
  }
  return false;
}

/** Programs that can send a file's contents over the network. */
const UPLOADERS = new Set(['curl', 'wget', 'http', 'https', 'xh']);
/** Programs whose first positional is a mode or owner, and change the rest. */
const WRITES_AFTER_FIRST = new Set(['chmod', 'chown', 'chgrp']);
/** Programs that change only their last path argument (the destination). */
const WRITES_LAST = new Set(['cp', 'install', 'ln', 'rsync', 'scp']);

/**
 * File names that hold secrets. A glob (`cat .e*`, Grep with glob `.env*`) is checked
 * against these, because belayd cannot list the folder to see what it will match.
 */
const SECRET_PROBES = [
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'id_rsa',
  'id_ed25519',
  'id_ecdsa',
  'server.key',
  'private.pem',
  'credentials',
  '.npmrc',
  '.netrc',
  '.pypirc',
  '.git-credentials',
];

/**
 * The secret names a glob in `dir` could match, as paths. Shell globs leave dotfiles
 * out (`*` does not match `.env`, `.e*` does); the globs of the Grep and Glob tools
 * follow ripgrep and gitignore, where `*.env` matches `.env` too.
 */
export function secretProbes(dir: string, glob: string, dot = false): string[] {
  let isMatch: (s: string) => boolean;
  try {
    isMatch = picomatch(glob, { dot, nocase: process.platform !== 'linux' });
  } catch {
    return [];
  }
  // A glob that also matches ordinary names (`*`, `*.*`) is not aimed at secrets.
  if (isMatch('notes.txt') || isMatch('index') || isMatch('sub/notes.txt')) return [];
  const out: string[] = [];
  for (const name of SECRET_PROBES) {
    if (isMatch(name) || isMatch(`sub/${name}`)) out.push(path.join(dir, name));
  }
  return out;
}

const MUTATING_MCP_TOOL =
  /write|edit|create|delete|remove|move|rename|update|patch|apply|upload|mkdir|save|put/i;
const SHELL_MCP_TOOL = /exec|run|shell|command|terminal|bash/i;
const PATH_KEYS =
  /^(path|paths|file|files|file_?path|filename|dir|directory|target|source|destination|dest|src|old_?path|new_?path|cwd)$/i;

/** Path-like values in MCP tool arguments: known keys, plus absolute or home-relative strings. */
function mcpPaths(args: unknown, depth = 0): string[] {
  if (depth > 4 || !args || typeof args !== 'object') return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      if (typeof v === 'string') {
        if (
          v.length > 0 &&
          v.length < 4096 &&
          !v.includes('\n') &&
          (PATH_KEYS.test(key) || /^(\/|~\/)/.test(v))
        ) {
          if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) out.push(v);
        }
      } else if (v && typeof v === 'object') out.push(...mcpPaths(v, depth + 1));
    }
  }
  return out;
}

function mcpCommand(args: unknown): string | undefined {
  if (!args || typeof args !== 'object') return undefined;
  const a = args as Record<string, unknown>;
  for (const key of ['command', 'cmd', 'script', 'shell_command']) {
    if (typeof a[key] === 'string') return a[key] as string;
    if (Array.isArray(a[key]) && (a[key] as unknown[]).every((x) => typeof x === 'string')) {
      return (a[key] as string[]).join(' ');
    }
  }
  return undefined;
}

const SPECIAL_FILES = /^\/dev\/(null|zero|stdout|stderr|stdin|tty|fd\/\d+|random|urandom)$/;
const GLOB_CHARS = /[*?[]/;

const committed = new Map<string, boolean>();

/**
 * True when a file is tracked by Git with no change, staged or not, against HEAD. One
 * `git status` per script and process; any doubt (no Git, not a repository, ignored,
 * untracked, modified) is false.
 */
export function committedUnchanged(file: string): boolean {
  let known = committed.get(file);
  if (known !== undefined) return known;
  try {
    const out = execFileSync(
      'git',
      [
        'status',
        '--porcelain=v1',
        '--ignored=matching',
        '--untracked-files=all',
        '--',
        path.basename(file),
      ],
      {
        cwd: path.dirname(file),
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        timeout: 2000,
      },
    );
    // A committed symlink can point at a file that is not: only a regular file counts.
    known = out.trim() === '' && fs.lstatSync(file).isFile();
  } catch {
    known = false;
  }
  committed.set(file, known);
  return known;
}

export function buildSubjects(
  action: Action,
  ctx: ActionContext,
  /** Files the agent changed earlier in this session: scripts among them are read before they run. */
  sessionWrites?: Set<string>,
): Subject[] {
  switch (action.kind) {
    case 'shell': {
      const analysis = analyzeShell(action.command, {
        cwd: ctx.cwd,
        home: ctx.home,
        env: safeEnv(),
        readScript,
        fileExists: (p) => fs.existsSync(p),
        ...(sessionWrites && sessionWrites.size > 0
          ? {
              agentWrote: (p: string) =>
                sessionWrites.has(p) || sessionWrites.has(canonicalPath(p)),
            }
          : {}),
        trustedScript: (p: string) =>
          !sessionWrites?.has(p) && !sessionWrites?.has(canonicalPath(p)) && committedUnchanged(p),
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
      const probes = action.glob
        ? secretProbes(p[p.length - 1]!, action.glob, true).flatMap(bothForms)
        : [];
      const all = [...p, ...probes];
      return [{ ...empty('read', ctx, action.path), paths: all, reads: all }];
    }
    case 'write': {
      const p = absolute(action.path, ctx);
      return [{ ...empty('write', ctx, action.path), paths: p, writes: p }];
    }
    case 'patch':
      return action.files.flatMap((f) =>
        [f.path, ...(f.to ? [f.to] : [])].map((p) => {
          const both = absolute(p, ctx);
          return { ...empty('write', ctx, `${f.op} ${p}`), paths: both, writes: both };
        }),
      );
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
      const files = mcpPaths(action.args).flatMap((p) => absolute(p, ctx));
      const writes = MUTATING_MCP_TOOL.test(action.tool);
      const main: Subject = {
        ...empty('mcp', ctx, `${action.server}: ${action.tool}`),
        domains: domainsIn(json),
        outbound: [json],
        paths: files,
        reads: writes ? [] : files,
        writes: writes ? files : [],
      };
      // Shell-style MCP tools (execute_command, run_terminal_cmd, ...) get the full shell analysis.
      const command = SHELL_MCP_TOOL.test(action.tool) ? mcpCommand(action.args) : undefined;
      const shell = command ? buildSubjects({ kind: 'shell', command }, ctx, sessionWrites) : [];
      return [main, ...shell];
    }
    case 'tool':
      return [empty('tool', ctx, action.name)];
  }
}

function fromInvocation(inv: Invocation, ctx: ActionContext): Subject {
  let program = inv.program || undefined;
  let raw = inv.argv.slice(1);
  // `node .../belayd/dist/bin.js approve` is belayd too, so rules about belayd apply.
  if (
    program &&
    JS_RUNTIMES.has(program) &&
    raw[0] &&
    BELAYD_BIN.test(raw[0].split('\\').join('/'))
  ) {
    program = 'belayd';
    raw = raw.slice(1);
  }
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
    // When the folder is one of a few known ones, a relative path is checked in each.
    // When it is unknown, the path is unknown too, and any known candidates are checked
    // as well so that a dangerous one is still caught.
    const relative = !p.startsWith('/') && !p.startsWith('~');
    if (inv.cwd === undefined && relative && !inv.cwdExhaustive) unresolved = true;
    const folders = inv.cwd !== undefined ? [inv.cwd] : (inv.cwdChoices ?? [undefined]);
    for (const folder of folders) {
      const full = inv.remote && !p.startsWith('/') ? undefined : resolveIn(folder, p, ctx.home);
      if (full === undefined) {
        unresolved = true;
        continue;
      }
      // `rm -rf /*` deletes everything in `/`, so the folder before the first glob counts too.
      const glob = full.search(GLOB_CHARS);
      if (glob >= 0) {
        out.push(full);
        const dir = path.dirname(full.slice(0, glob + 1));
        out.push(...bothForms(dir));
        // `cat .e*` reads .env: check the glob against secret file names.
        out.push(...secretProbes(dir, path.relative(dir, full)).flatMap(bothForms));
      } else {
        out.push(...bothForms(full));
      }
    }
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

  // `curl -d @.env`, `curl -F f=@.env`, `curl -T .env` and `wget --post-file=.env`
  // read a file and send it.
  if (program && UPLOADERS.has(program)) {
    for (let i = 0; i < raw.length; i++) {
      const a = raw[i]!;
      const next = raw[i + 1];
      let file: string | undefined;
      const eq = /^--(?:data[a-z-]*|form[a-z-]*|post-file|body-file|upload-file)=(.+)$/.exec(a);
      if (eq) file = eq[1];
      else if (
        /^(-d|--data[a-z-]*|-F|--form[a-z-]*|-T|--upload-file|--post-file|--body-file)$/.test(a)
      )
        file = next;
      if (file === undefined) continue;
      // -d @file and -F name=@file or name=<file name a file; -T and --post-file always do.
      const m = /^(?:[^=@<]*=)?[@<](.+)$/.exec(file);
      const target = m
        ? m[1]!.replace(/;.*$/, '')
        : /^(-T|--upload-file|--post-file|--body-file)/.test(a)
          ? file
          : undefined;
      if (target && target !== '-')
        resolve(target).forEach((p) => (explicitReads.add(p), paths.add(p)));
    }
  }

  // `git show HEAD:.env` and `git cat-file -p rev:path` read a file from history.
  if (program === 'git' && ['show', 'cat-file'].includes(positionals[0] ?? '')) {
    for (const a of positionals.slice(1)) {
      const m = /^[^:\s]*:(.+)$/.exec(a);
      if (m && inv.cwd)
        bothForms(path.resolve(ctx.workspace, m[1]!)).forEach(
          (p) => (paths.add(p), explicitReads.add(p)),
        );
    }
  }

  const reads = new Set(
    LISTS_ONLY.has(program ?? '') || showsNoContent(program, positionals, raw)
      ? []
      : [...paths].filter((p) => !writes.has(p) || program === 'mv'),
  );
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
    runs: inv.scripts.flatMap(bothForms),
    drivenBy: (inv.cwd !== undefined
      ? [inv.cwd]
      : [...(inv.cwdChoices ?? []), ...(inv.cwdExhaustive ? [] : [ctx.workspace])]
    )
      .flatMap((cwd) => drivers(program, positionals, raw, cwd, ctx.workspace))
      .flatMap((d) =>
        d.endsWith('/') ? bothForms(d.slice(0, -1)).map((x) => `${x}/`) : bothForms(d),
      ),
    // In your own committed script, what belayd cannot see is not a question.
    dynamic: inv.trusted ? false : inv.dynamic,
    unresolved: inv.trusted ? false : unresolved,
    inlineCode: inv.inlineCode,
    remote: inv.remote,
    parseError: false,
    trusted: inv.trusted === true,
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
  // Found from each `://`, so a long run of scheme-like text cannot make it slow.
  for (let at = text.indexOf('://'); at >= 0; at = text.indexOf('://', at + 3)) {
    let start = at;
    while (start > 0 && at - start < 32 && /[a-z0-9+.-]/i.test(text[start - 1]!)) start--;
    if (start === at || !/[a-z]/i.test(text[start]!)) continue;
    if (start > 0 && /\w/.test(text[start - 1]!)) continue;
    const m = /^(?:[^/\s:@"']+(?::[^/\s@"']*)?@)?([^/\s:?#"'`)]+)/.exec(
      text.slice(at + 3, at + 3 + 2048),
    );
    if (m) out.push(m[1]!.toLowerCase().replace(/\.$/, ''));
  }
  return out;
}

/**
 * A path as written and as it really is on disk (symlinks resolved). Rules match if
 * either form matches, so `/etc` is still `/etc` on macOS (really /private/etc), and a
 * symlink in the project that points into ~/.ssh is judged as ~/.ssh.
 */
function bothForms(p: string): string[] {
  const real = canonicalPath(p);
  return real === p ? [p] : [p, real];
}

function absolute(p: string, ctx: ActionContext): string[] {
  return bothForms(resolveIn(ctx.cwd, p, ctx.home) ?? path.resolve(ctx.cwd, p));
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
    runs: [],
    drivenBy: [],
    dynamic: false,
    unresolved: false,
    inlineCode: false,
    remote: false,
    parseError: false,
    trusted: false,
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

const JS_RUNTIMES = new Set(['node', 'nodejs', 'bun']);
const BELAYD_BIN = /(^|\/)(belayd|belayd-cli|leashd)\/dist\/bin\.js$/;

const SCRIPT_RUNNERS = new Set([
  'run',
  'run-script',
  'test',
  't',
  'start',
  'stop',
  'restart',
  'exec',
  'x',
  'dlx',
]);
/** Built-in pnpm and bun commands; any other first word is a package script. */
const PACKAGE_MANAGER_COMMANDS = new Set([
  'add',
  'audit',
  'bin',
  'build',
  'ci',
  'config',
  'create',
  'deploy',
  'dlx',
  'env',
  'exec',
  'fetch',
  'help',
  'i',
  'import',
  'init',
  'install',
  'licenses',
  'link',
  'list',
  'ls',
  'outdated',
  'pack',
  'patch',
  'pm',
  'prune',
  'publish',
  'rebuild',
  'remove',
  'rm',
  'root',
  'run',
  'server',
  'setup',
  'start',
  'store',
  'test',
  't',
  'unlink',
  'up',
  'update',
  'upgrade',
  'why',
  'x',
]);
/** Commands that run a package's install scripts when given no package names. */
const INSTALLERS = new Set(['install', 'i', 'ci', 'add', 'rebuild', 'link', 'pack', 'publish']);
const GIT_HOOKED = new Set([
  'commit',
  'push',
  'merge',
  'rebase',
  'checkout',
  'switch',
  'am',
  'pull',
  'cherry-pick',
]);

/** Files that decide what a runner does. A trailing slash means anything inside. */
function drivers(
  program: string | undefined,
  positionals: string[],
  raw: string[],
  cwd: string | undefined,
  workspace: string,
): string[] {
  if (!program || !cwd) return [];
  const here = (f: string) => path.join(cwd, f);
  switch (program) {
    case 'npm':
    case 'pnpm':
    case 'yarn':
    case 'bun': {
      const sub = positionals[0];
      // Running a script, or installing, which runs the package's own install scripts.
      // pnpm and bun also run a package script named directly: `pnpm lint`.
      const runs =
        SCRIPT_RUNNERS.has(sub ?? '') ||
        (INSTALLERS.has(sub ?? '') && positionals.length === 1) ||
        (program === 'yarn' && (positionals.length > 0 || sub === undefined)) ||
        ((program === 'pnpm' || program === 'bun') &&
          sub !== undefined &&
          !PACKAGE_MANAGER_COMMANDS.has(sub));
      if (!runs) return [];
      // `npm --prefix dir`, `pnpm -C dir` and `npm -w pkg` use another package.json.
      const out = [here('package.json')];
      for (let i = 0; i < raw.length; i++) {
        if (PACKAGE_MANAGER_OPTIONS[program]!.has(raw[i]!) && raw[i + 1])
          out.push(path.resolve(cwd, raw[i + 1]!, 'package.json'));
        const eq = /^--(?:prefix|dir|cwd|workspace)=(.+)$/.exec(raw[i]!);
        if (eq) out.push(path.resolve(cwd, eq[1]!, 'package.json'));
      }
      return out;
    }
    case 'node':
      return raw.includes('--run') || raw.some((a) => a.startsWith('--run='))
        ? [here('package.json')]
        : [];
    case 'cargo':
      return ['build', 'b', 'run', 'r', 'test', 't', 'check', 'c', 'bench'].includes(
        positionals[0] ?? '',
      )
        ? [here('build.rs'), here('Cargo.toml')]
        : [];
    case 'make':
    case 'gmake': {
      const f = raw.findIndex((a) => a === '-f' || a === '--file' || a === '--makefile');
      if (f >= 0 && raw[f + 1]) return [path.resolve(cwd, raw[f + 1]!)];
      return [here('Makefile'), here('makefile'), here('GNUmakefile')];
    }
    case 'just':
      return [here('justfile'), here('Justfile'), here('.justfile')];
    case 'task':
      return [here('Taskfile.yml'), here('Taskfile.yaml')];
    case 'pre-commit':
      return [here('.pre-commit-config.yaml')];
    case 'git':
      // Hooks live in .git/hooks, or wherever husky, lefthook or pre-commit point them.
      return GIT_HOOKED.has(positionals[0] ?? '')
        ? [
            `${path.join(workspace, '.git', 'hooks')}/`,
            `${path.join(workspace, '.husky')}/`,
            path.join(workspace, 'lefthook.yml'),
            path.join(workspace, '.lefthook.yml'),
            path.join(workspace, '.pre-commit-config.yaml'),
          ]
        : [];
    default:
      return [];
  }
}

const MAX_SCRIPT_BYTES = 256 * 1024;

/** Reads a script before it runs, so `bash cleanup.sh` is checked line by line. */
function readScript(p: string): { text: string; truncated: boolean } | undefined {
  try {
    const { text, size } = readRegularFile(p, MAX_SCRIPT_BYTES);
    return { text, truncated: size > MAX_SCRIPT_BYTES };
  } catch {
    return undefined;
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
