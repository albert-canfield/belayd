import fs from 'node:fs';
import path from 'node:path';
import pc from 'picocolors';
import { POLICY_FILE } from '../policy/load.js';
import { isTrusted, revokeTrust, trustFile } from '../policy/trust.js';
import { belaydHome, findWorkspace } from '../util/paths.js';
import { insideAgent } from './approve.js';

export interface TrustOptions {
  revoke?: boolean;
}

/** `belayd trust [file]`: review a project belayd.yaml and let all of it apply. */
export async function trust(fileArg: string | undefined, opts: TrustOptions): Promise<number> {
  if (insideAgent(process.env)) {
    console.error('belayd trust must be run by a person, not from inside an agent session.');
    return 77;
  }
  const home = belaydHome();
  const file = path.resolve(fileArg ?? path.join(findWorkspace(process.cwd()), POLICY_FILE));
  if (!fs.existsSync(file)) {
    console.error(`No policy file at ${file}`);
    return 1;
  }
  if (opts.revoke) {
    console.log(revokeTrust(home, file) ? `Stopped trusting ${file}.` : `${file} was not trusted.`);
    return 0;
  }

  // Show what trusting unlocks, so the decision is an informed one.
  const { readPolicyFile } = await import('../policy/compile.js');
  const policy = readPolicyFile(file);
  const unlocks: string[] = [];
  for (const r of policy.rules.filter((x) => x.decision === 'allow')) {
    unlocks.push(`allow rule ${pc.bold(r.id)}`);
  }
  if (policy.disable.length > 0) unlocks.push(`switches off: ${policy.disable.join(', ')}`);
  if (policy.extends && policy.extends !== 'balanced')
    unlocks.push(`uses the ${policy.extends} preset`);
  if (policy.default) unlocks.push(`default: ${policy.default}`);
  if (policy.failMode === 'open')
    unlocks.push('failMode: open (belayd steps aside when it errors)');
  if (policy.approval?.onTimeout === 'allow') unlocks.push('approval.onTimeout: allow');
  if (policy.snapshots?.enabled === false) unlocks.push('snapshots off (no undo)');

  if (isTrusted(home, file)) {
    console.log(`${file} is already trusted.`);
    return 0;
  }
  trustFile(home, file);
  console.log(pc.green(`✔ Trusted ${file}`));
  if (unlocks.length > 0) {
    console.log(pc.dim('  It can now:'));
    for (const u of unlocks) console.log(pc.dim(`    ${u}`));
  }
  console.log(pc.dim('  Any later edit to the file untrusts it until you run belayd trust again.'));
  return 0;
}
