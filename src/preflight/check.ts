import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { shellQuote } from '../agents/common.js';
import { inventory, type OwnCommand, type SetupItem } from './inventory.js';

/**
 * Before an agent works in a project, a look at what the project brings that can run
 * code or steer the agent (src/preflight/inventory.ts). belayd remembers what the person
 * approved per project and asks again only when something is new or changed:
 *
 * - The check runs on every tool call, from files only. When something is new, the call
 *   gets a question (rule ask-project-setup) and the items it named are kept as pending.
 * - The person's yes reaches belayd as the call running: its after-event turns pending
 *   into approved. An agent that shows its own prompt never tells belayd the answer, so
 *   this is the one signal every agent gives.
 * - A project belayd worked in before it had this check is recorded as it is, without a
 *   question: trust on first use for projects you were already using. `belayd init` and
 *   the GitHub Action approve the project they set up.
 */

interface State {
  approved: Record<string, string>;
  pending?: Record<string, string>;
}

const MAX_SHOWN = 4;

function id(workspace: string): string {
  return crypto.createHash('sha256').update(workspace).digest('hex').slice(0, 16);
}

function stateFile(belaydHome: string, workspace: string): string {
  return path.join(belaydHome, 'preflight', `${id(workspace)}.json`);
}

function readState(belaydHome: string, workspace: string): State | undefined {
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(belaydHome, workspace), 'utf8')) as State;
    return s && typeof s.approved === 'object' ? s : undefined;
  } catch {
    return undefined;
  }
}

function writeState(belaydHome: string, workspace: string, state: State): void {
  try {
    const file = stateFile(belaydHome, workspace);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    // only costs this check: it asks again next time
  }
}

/** True when belayd has worked in this project before (its ledger or its snapshots). */
function seenBefore(belaydHome: string, workspace: string): boolean {
  const key = id(workspace);
  if (fs.existsSync(path.join(belaydHome, 'live', key))) return true;
  try {
    return fs.readdirSync(path.join(belaydHome, 'snapshots')).some((d) => d.endsWith(`-${key}`));
  } catch {
    return false;
  }
}

/** belayd's own hook command for the node and bin.js running now, in any agent's form. */
export function ownCommand(nodePath: string, binPath: string): OwnCommand {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(
    `^${esc(shellQuote(nodePath))} ${esc(shellQuote(binPath))} hook [a-z][a-z-]* --timeout \\d+( --event [A-Za-z]+)?` +
      `( \\|\\| \\{ echo "belayd is not working, so this action is blocked to be safe\\. Run: belayd doctor" >&2; exit 2; \\})?$`,
  );
  return (command) => re.test(command.trim());
}

const toMap = (items: SetupItem[]) => Object.fromEntries(items.map((i) => [i.key, i.hash]));

/** What is new or changed since the last approval, without changing anything. */
export function setupChanges(
  belaydHome: string,
  workspace: string,
  own: OwnCommand,
): { items: SetupItem[]; changed: SetupItem[]; known: boolean } {
  const items = inventory(workspace, own);
  const state = readState(belaydHome, workspace);
  const changed = state ? items.filter((i) => state.approved[i.key] !== i.hash) : items;
  return { items, changed, known: state !== undefined };
}

/**
 * A check to pass to `evaluate`: the description of what is new in this project's setup,
 * or undefined. It reads the project once per evaluation.
 */
export function makeSetupCheck(opts: {
  belaydHome: string;
  workspace: string;
  own: OwnCommand;
}): () => string | undefined {
  let result: { detail: string | undefined } | undefined;
  return () => {
    if (result) return result.detail;
    const { belaydHome, workspace } = opts;
    const { items, changed, known } = setupChanges(belaydHome, workspace, opts.own);
    if (!known && (items.length === 0 || seenBefore(belaydHome, workspace))) {
      writeState(belaydHome, workspace, { approved: toMap(items) });
      return (result = { detail: undefined }).detail;
    }
    if (changed.length === 0) return (result = { detail: undefined }).detail;
    const state = readState(belaydHome, workspace) ?? { approved: {} };
    writeState(belaydHome, workspace, { ...state, pending: toMap(items) });
    const shown = changed.slice(0, MAX_SHOWN).map((i) => i.label);
    const more = changed.length > MAX_SHOWN ? `; and ${changed.length - MAX_SHOWN} more` : '';
    const what = known
      ? 'new or changed since you last approved it'
      : 'in a project belayd has not seen before';
    return (result = {
      detail: `${what}: ${shown.join('; ')}${more}. List all: belayd preflight`,
    }).detail;
  };
}

/** After a call ran: the person said yes to what the question showed. */
export function confirmSetup(belaydHome: string, workspace: string): void {
  const state = readState(belaydHome, workspace);
  if (!state?.pending) return;
  writeState(belaydHome, workspace, { approved: state.pending });
}

/** Records the project's setup as it is now (belayd init, `belayd preflight --approve`). */
export function approveSetup(belaydHome: string, workspace: string, own: OwnCommand): SetupItem[] {
  const items = inventory(workspace, own);
  writeState(belaydHome, workspace, { approved: toMap(items) });
  return items;
}
