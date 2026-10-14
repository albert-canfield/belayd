import { buildSubjects, type Subject } from '../policy/subjects.js';
import type { Action, ActionContext } from '../policy/types.js';
import { canonicalPath } from '../util/paths.js';

/** What to capture before an action runs. */
export type Scope = { kind: 'none' } | { kind: 'all' } | { kind: 'paths'; paths: string[] };

/** Programs that only read. A shell command made only of these needs no snapshot. */
const READ_ONLY = new Set([
  'ls',
  'll',
  'cat',
  'head',
  'tail',
  'less',
  'more',
  'wc',
  'grep',
  'egrep',
  'fgrep',
  'rg',
  'ag',
  'ack',
  'find',
  'pwd',
  'echo',
  'printf',
  'which',
  'type',
  'file',
  'stat',
  'du',
  'df',
  'tree',
  'date',
  'whoami',
  'uname',
  'id',
  'hostname',
  'true',
  'false',
  'test',
  '[',
  'sort',
  'uniq',
  'cut',
  'tr',
  'jq',
  'yq',
  'xxd',
  'od',
  'basename',
  'dirname',
  'realpath',
  'readlink',
  'sleep',
  'cd',
  'ps',
  'lsof',
  'env',
  'printenv',
  'diff',
  'cmp',
  'md5',
  'md5sum',
  'shasum',
  'sha256sum',
  'column',
  'nl',
  'sed',
  'awk',
  'curl',
]);

const GIT_READ_ONLY = new Set([
  'status',
  'diff',
  'log',
  'show',
  'blame',
  'rev-parse',
  'ls-files',
  'ls-tree',
  'cat-file',
  'describe',
  'shortlog',
  'grep',
  'reflog',
]);

const MUTATING_TOOL =
  /write|edit|create|delete|remove|move|rename|update|patch|apply|upload|mkdir/i;

export function snapshotScope(action: Action, ctx: ActionContext): Scope {
  switch (action.kind) {
    case 'write': {
      const rel = relativeTo(ctx.workspace, action.path, ctx.cwd);
      return rel ? { kind: 'paths', paths: [rel] } : { kind: 'none' };
    }
    case 'shell': {
      const subjects = buildSubjects(action, ctx);
      return subjects.every(readOnly) ? { kind: 'none' } : { kind: 'all' };
    }
    case 'mcp':
      return MUTATING_TOOL.test(action.tool) ? { kind: 'all' } : { kind: 'none' };
    default:
      return { kind: 'none' };
  }
}

function readOnly(s: Subject): boolean {
  if (s.parseError || s.dynamic || s.inlineCode || s.codeFrom.length > 0) return false;
  if (s.writes.length > 0) return false;
  if (!s.program) return false;
  if (s.program === 'git') return GIT_READ_ONLY.has(s.positionals[0] ?? '');
  if (
    s.program === 'sed' &&
    s.args.some((a) => a === '-i' || a.startsWith('-i') || a === '--in-place')
  )
    return false;
  if (
    s.program === 'find' &&
    s.args.some((a) => a === '-delete' || a.startsWith('-exec') || a.startsWith('-ok'))
  )
    return false;
  return READ_ONLY.has(s.program);
}

function relativeTo(workspace: string, file: string, cwd: string): string | undefined {
  const abs = canonicalPath(file.startsWith('/') ? file : `${cwd}/${file}`);
  const root = canonicalPath(workspace);
  if (!abs.startsWith(root + '/')) return undefined;
  return abs.slice(root.length + 1);
}
