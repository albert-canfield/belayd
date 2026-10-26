import path from 'node:path';
import pc from 'picocolors';
import { installedBinPath } from './init.js';
import { approveSetup, ownCommand, setupChanges } from '../preflight/check.js';
import { belaydHome, findWorkspace } from '../util/paths.js';

/**
 * `belayd preflight`: what this project brings that can run code or steer an agent, and
 * which of it is new since you last approved. `--approve` records it as it is now, for
 * agents that ask through belayd's own channels and for scripts.
 */
export async function preflight(opts: { approve?: boolean; json?: boolean }): Promise<number> {
  const workspace = findWorkspace(process.cwd());
  const own = ownCommand(process.execPath, installedBinPath());
  if (opts.approve) {
    const items = approveSetup(belaydHome(), workspace, own);
    if (opts.json) console.log(JSON.stringify({ workspace, approved: items }, null, 2));
    else
      console.log(
        pc.green(
          `✔ Approved ${items.length} thing${items.length === 1 ? '' : 's'} in ${path.basename(workspace)}. belayd asks again when one changes.`,
        ),
      );
    return 0;
  }
  const { items, changed } = setupChanges(belaydHome(), workspace, own);
  if (opts.json) {
    const isNew = new Set(changed.map((i) => i.key));
    console.log(
      JSON.stringify(
        { workspace, items: items.map((i) => ({ ...i, new: isNew.has(i.key) })) },
        null,
        2,
      ),
    );
    return 0;
  }
  console.log(pc.bold(`belayd preflight · ${path.basename(workspace)}`));
  if (items.length === 0) {
    console.log('Nothing in this project runs code or steers an agent on its own.');
    return 0;
  }
  console.log('Things in this project that can run code or steer an agent:\n');
  const isNew = new Set(changed.map((i) => i.key));
  for (const i of items) {
    console.log(`  ${isNew.has(i.key) ? pc.yellow('new') : pc.green('ok ')}  ${i.label}`);
  }
  console.log('');
  console.log(
    changed.length > 0
      ? `${changed.length} new or changed since you last approved. Look at them, then: belayd preflight --approve`
      : pc.dim('All approved. belayd asks again when one changes.'),
  );
  return 0;
}
