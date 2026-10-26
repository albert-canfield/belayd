import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Subject } from '../policy/subjects.js';

/**
 * Packages a command asks to install that the project does not have yet. Models make up
 * package names (about one in twenty, in published studies), and attackers register the
 * names they make up. Only names worth a registry lookup come out of here: not already in
 * the project's manifest or lockfile, and not from a private registry or index.
 */

export type Ecosystem = 'npm' | 'pypi';

export interface PackageRequest {
  ecosystem: Ecosystem;
  name: string;
}

const NPM_ADD: Record<string, string[]> = {
  npm: ['install', 'i', 'add', 'in', 'isntall'],
  pnpm: ['add', 'install', 'i'],
  yarn: ['add'],
  bun: ['add', 'install', 'i'],
};

/** What this subject would install from a public registry, in the project at `workspace`. */
export function requestedPackages(
  s: Subject,
  workspace: string,
  env: NodeJS.ProcessEnv,
): PackageRequest[] {
  if (s.kind !== 'shell' || !s.program || s.dynamic) return [];
  const p = s.program;
  const pos = s.positionals;
  let ecosystem: Ecosystem | undefined;
  let specs: string[] = [];
  // Running a package straight from the registry: npx, pnpm dlx, bunx, npm exec, uvx.
  let runs = false;
  if (NPM_ADD[p]?.includes(pos[0] ?? '')) {
    ecosystem = 'npm';
    specs = pos.slice(1);
  } else if (p === 'npx' || p === 'pnpx' || p === 'bunx') {
    ecosystem = 'npm';
    specs = [optionValue(s.argv, ['-p', '--package']) ?? pos[0] ?? ''];
    runs = true;
  } else if (
    (p === 'npm' && pos[0] === 'exec') ||
    ((p === 'pnpm' || p === 'yarn') && pos[0] === 'dlx')
  ) {
    ecosystem = 'npm';
    specs = [optionValue(s.argv, ['-p', '--package']) ?? pos[1] ?? ''];
    runs = true;
  } else if ((p === 'pip' || p === 'pip3' || p === 'pipx') && pos[0] === 'install') {
    ecosystem = 'pypi';
    specs = pos.slice(1);
  } else if (/^python[0-9.]*$/.test(p)) {
    // `python -m pip install x`
    const m = s.argv.indexOf('-m');
    if (m > 0 && /^pip[0-9.]*$/.test(s.argv[m + 1] ?? '') && s.argv[m + 2] === 'install') {
      ecosystem = 'pypi';
      specs = withoutOptions(s.argv.slice(m + 3));
    }
  } else if (p === 'uv' && pos[0] === 'pip' && pos[1] === 'install') {
    ecosystem = 'pypi';
    specs = pos.slice(2);
  } else if ((p === 'uv' || p === 'poetry') && pos[0] === 'add') {
    ecosystem = 'pypi';
    specs = pos.slice(1);
  } else if (p === 'uvx' || (p === 'pipx' && pos[0] === 'run')) {
    ecosystem = 'pypi';
    specs = [optionValue(s.argv, ['--from']) ?? (p === 'uvx' ? pos[0] : pos[1]) ?? ''];
    runs = true;
  }
  if (!ecosystem || specs.length === 0) return [];
  if (ecosystem === 'pypi') {
    // A requirements file, an editable install or another index: not a bare name.
    if (
      s.args.some((a) =>
        /^(-r|--requirement|-e|--editable|-i|--index-url|--extra-index-url|--find-links|-f)(=|$)/.test(
          a,
        ),
      )
    )
      return [];
    if (privateIndex(env)) return [];
  }
  const known = projectPackages(workspace, ecosystem);
  const out: PackageRequest[] = [];
  for (const spec of specs) {
    const name = ecosystem === 'npm' ? npmName(spec) : pypiName(spec);
    if (!name || known.has(name)) continue;
    // `npx tsc` runs the project's own installed command first.
    if (
      runs &&
      ecosystem === 'npm' &&
      fs.existsSync(path.join(workspace, 'node_modules', '.bin', path.posix.basename(name)))
    )
      continue;
    if (ecosystem === 'npm' && privateNpmRegistry(workspace, env, name)) continue;
    out.push({ ecosystem, name });
  }
  return out;
}

/** `left-pad@^1`, `@scope/pkg@2` → the name; paths, URLs, git and aliases → undefined. */
export function npmName(spec: string): string | undefined {
  if (/^[./~]|:|\//.test(spec.replace(/^@[^/]+\//, ''))) return undefined;
  const m = /^((?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*)(?:@.*)?$/i.exec(spec);
  return m ? m[1]!.toLowerCase() : undefined;
}

/** `Requests[socks]>=2` → `requests`; paths, URLs and archives → undefined. */
export function pypiName(spec: string): string | undefined {
  if (/^[./~]|:\/\/|\.(whl|zip|tar\.gz)$/i.test(spec)) return undefined;
  const m = /^([A-Za-z0-9][A-Za-z0-9._-]*)(\[[^\]]*\])?\s*([<>=!~;@].*)?$/.exec(spec);
  return m ? m[1]!.toLowerCase().replace(/[._]+/g, '-') : undefined;
}

/** Names the project already declares or has locked. */
function projectPackages(workspace: string, ecosystem: Ecosystem): Set<string> {
  const names = new Set<string>();
  const read = (f: string) => {
    try {
      const st = fs.statSync(path.join(workspace, f));
      return st.size < 32 * 1024 * 1024 ? fs.readFileSync(path.join(workspace, f), 'utf8') : '';
    } catch {
      return '';
    }
  };
  if (ecosystem === 'npm') {
    try {
      const pkg = JSON.parse(read('package.json') || '{}') as Record<string, unknown>;
      for (const key of [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies',
      ])
        for (const n of Object.keys((pkg[key] as object) ?? {})) names.add(n.toLowerCase());
    } catch {
      // unreadable manifest: nothing known from it
    }
    const locks = ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock']
      .map(read)
      .join('\n');
    for (const m of locks.matchAll(
      /(?:node_modules\/|^\s*['"]?\/?)((?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+)@/gim,
    ))
      names.add(m[1]!.toLowerCase());
    for (const m of locks.matchAll(/node_modules\/((?:@[a-z0-9._~-]+\/)?[a-z0-9._~-]+)"/gi))
      names.add(m[1]!.toLowerCase());
  } else {
    const text = [
      'requirements.txt',
      'requirements-dev.txt',
      'pyproject.toml',
      'setup.cfg',
      'Pipfile',
      'uv.lock',
      'poetry.lock',
    ]
      .map(read)
      .join('\n');
    for (const m of text.matchAll(/[A-Za-z0-9][A-Za-z0-9._-]*/g))
      names.add(m[0].toLowerCase().replace(/[._]+/g, '-'));
  }
  return names;
}

/** True when npm would fetch this package from somewhere other than the public registry. */
function privateNpmRegistry(workspace: string, env: NodeJS.ProcessEnv, name: string): boolean {
  const pub = /^https?:\/\/registry\.(npmjs\.org|yarnpkg\.com)\/?$/i;
  const scope = name.startsWith('@') ? name.split('/')[0] : undefined;
  const fromEnv = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY;
  if (fromEnv && !pub.test(fromEnv.trim())) return true;
  for (const file of [
    path.join(workspace, '.npmrc'),
    path.join(env.HOME || os.homedir(), '.npmrc'),
  ]) {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const m = /^\s*(@[^:\s]+:)?registry\s*=\s*(\S+)/.exec(line);
      if (!m) continue;
      if (m[1] && m[1] !== `${scope}:`) continue;
      if (!pub.test(m[2]!)) return true;
    }
  }
  return false;
}

/** True when pip or uv is set up to install from an index other than PyPI. */
function privateIndex(env: NodeJS.ProcessEnv): boolean {
  for (const v of [
    'PIP_INDEX_URL',
    'PIP_EXTRA_INDEX_URL',
    'UV_INDEX_URL',
    'UV_DEFAULT_INDEX',
    'UV_INDEX',
  ])
    if (env[v]) return true;
  const home = env.HOME || os.homedir();
  for (const f of [
    path.join(home, '.config/pip/pip.conf'),
    path.join(home, '.pip/pip.conf'),
    '/etc/pip.conf',
  ]) {
    try {
      if (/^\s*(extra-)?index-url\s*=/m.test(fs.readFileSync(f, 'utf8'))) return true;
    } catch {
      // no such file
    }
  }
  return false;
}

/** The value of the first of these options in an argument list (`-p x` or `--package=x`). */
function optionValue(argv: string[], names: string[]): string | undefined {
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (names.includes(a)) return argv[i + 1];
    for (const n of names)
      if (n.startsWith('--') && a.startsWith(`${n}=`)) return a.slice(n.length + 1);
  }
  return undefined;
}

/** pip arguments without options and the values of options that take one. */
function withoutOptions(args: string[]): string[] {
  const takesValue =
    /^(-t|--target|-c|--constraint|--prefix|--root|--src|--python-version|--platform|--implementation|--abi|--upgrade-strategy|--progress-bar|--log|--cache-dir|--proxy|--retries|--timeout)$/;
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (takesValue.test(a)) i++;
    else if (!a.startsWith('-')) out.push(a);
  }
  return out;
}
