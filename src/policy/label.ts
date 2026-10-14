import path from 'node:path';
import { canonicalPath } from '../util/paths.js';
import type { Action } from './types.js';

/**
 * One line (or block) a person can judge quickly. Paths inside the project are shown
 * relative to it; a path outside stays absolute, since that is what needs noticing.
 */
export function actionLabel(action: Action, workspace?: string): string {
  const shown = (p: string) => (workspace ? inside(p, workspace) : p);
  switch (action.kind) {
    case 'shell':
      return action.command;
    case 'read':
      return `read ${shown(action.path)}${action.glob ? ` (${action.glob})` : ''}`;
    case 'write':
      return `write ${shown(action.path)}`;
    case 'fetch':
      return `${action.method ?? 'GET'} ${action.url}`;
    case 'mcp': {
      let args: string;
      try {
        args = JSON.stringify(action.args);
      } catch {
        args = '';
      }
      return `${action.server}: ${action.tool} ${args.length > 400 ? `${args.slice(0, 397)}...` : args}`;
    }
    case 'patch':
      return `apply_patch: ${action.files.map((f) => `${f.op} ${shown(f.path)}${f.to ? ` -> ${shown(f.to)}` : ''}`).join(', ')}`;
    case 'tool':
      return action.name;
  }
}

function inside(p: string, workspace: string): string {
  if (!path.isAbsolute(p)) return p;
  for (const candidate of [p, canonicalPath(p)]) {
    const rel = path.relative(workspace, candidate);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
  }
  return p;
}
