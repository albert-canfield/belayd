import type { Action } from './types.js';

/** One line (or block) a person can judge quickly. */
export function actionLabel(action: Action): string {
  switch (action.kind) {
    case 'shell':
      return action.command;
    case 'read':
      return `read ${action.path}`;
    case 'write':
      return `write ${action.path}`;
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
    case 'tool':
      return action.name;
  }
}
