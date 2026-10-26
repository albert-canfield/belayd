/**
 * Git options that make Git run a command, or that switch the project's hooks off:
 * `git config core.fsmonitor 'curl … | sh'`, `git -c core.hooksPath=/dev/null commit`,
 * a filter driver, an ssh command. Reading an option, removing one, or setting one to a
 * value that runs nothing (`core.fsmonitor=false`, an empty filter) is fine.
 */

/** Keys whose value is a command, matched lowercase; `*` is one subsection name. */
const COMMAND_KEYS = [
  'core.fsmonitor',
  'core.sshcommand',
  'core.gitproxy',
  'core.askpass',
  'core.pager',
  'core.editor',
  'sequence.editor',
  'diff.external',
  'diff.*.textconv',
  'diff.*.command',
  'merge.*.driver',
  'filter.*.clean',
  'filter.*.smudge',
  'filter.*.process',
  'credential.helper',
  'gpg.program',
  'uploadpack.packobjectshook',
];

/** Values that run nothing. core.fsmonitor=true is Git's own built-in daemon. */
const HARMLESS = new Set(['', 'false', 'true', 'no', 'yes', 'off', 'on', '0', '1']);

/** `git config` options that take a value, so it is not mistaken for the key. */
const CONFIG_VALUE_OPTIONS = new Set([
  '-f',
  '--file',
  '--blob',
  '--type',
  '--default',
  '--comment',
  '--value',
  '--fixed-value',
]);
/** `git config` modes that only read or remove. */
const CONFIG_READS = new Set([
  '--get',
  '--get-all',
  '--get-regexp',
  '--get-urlmatch',
  '--get-color',
  '--get-colorbool',
  '-l',
  '--list',
  '--unset',
  '--unset-all',
  '--remove-section',
  '--rename-section',
  '-e',
  '--edit',
]);
const CONFIG_SUBCOMMANDS = new Set([
  'get',
  'list',
  'unset',
  'remove-section',
  'rename-section',
  'edit',
]);

function keyMatches(key: string): boolean {
  const k = key.toLowerCase();
  return COMMAND_KEYS.some((pattern) => {
    const p = pattern.split('.');
    const parts = k.split('.');
    if (p.length === 2) return parts.length === 2 && parts[0] === p[0] && parts[1] === p[1];
    // section.subsection.key, where the subsection may itself contain dots
    return parts.length >= 3 && parts[0] === p[0] && parts[parts.length - 1] === p[2];
  });
}

/** Why setting this Git option to this value runs code or switches hooks off, or undefined. */
export function optionRunsCode(key: string, value: string): string | undefined {
  const k = key.toLowerCase();
  if (k === 'core.hookspath') {
    return value === '/dev/null' || value === 'NUL'
      ? `${key}=${value} switches the project's Git hooks off`
      : `${key}=${value} runs hooks from another folder`;
  }
  if (k.startsWith('alias.') && value.trimStart().startsWith('!'))
    return `${key} makes a Git alias that runs a shell command`;
  if (keyMatches(key) && !HARMLESS.has(value.trim().toLowerCase()))
    return `${key} makes Git run a command`;
  return undefined;
}

/** Why this git invocation sets an option that runs code or skips hooks, or undefined. */
export function gitRunsCode(program: string | undefined, raw: string[]): string | undefined {
  if (program !== 'git') return undefined;
  let i = 0;
  // Global options before the subcommand: `-c key=value` sets an option for one command.
  for (; i < raw.length; i++) {
    const w = raw[i]!;
    if (w === '-c' && i + 1 < raw.length) {
      const pair = raw[++i]!;
      const eq = pair.indexOf('=');
      const hit = eq > 0 ? optionRunsCode(pair.slice(0, eq), pair.slice(eq + 1)) : undefined;
      if (hit) return hit;
    } else if (w === '-C' || w === '--git-dir' || w === '--work-tree' || w === '--namespace') {
      i++;
    } else if (!w.startsWith('-')) break;
  }
  if (raw[i] !== 'config') return undefined;
  const words: string[] = [];
  for (let j = i + 1; j < raw.length; j++) {
    const w = raw[j]!;
    if (CONFIG_READS.has(w)) return undefined;
    if (CONFIG_VALUE_OPTIONS.has(w)) {
      j++;
      continue;
    }
    if (w.startsWith('-')) continue;
    words.push(w);
  }
  // `git config set key value` (Git 2.46) and `git config key value`.
  if (words[0] === 'set') words.shift();
  else if (CONFIG_SUBCOMMANDS.has(words[0] ?? '')) return undefined;
  const [key, value] = words;
  // Only the key: that reads it.
  if (key === undefined || value === undefined) return undefined;
  return optionRunsCode(key, value);
}
