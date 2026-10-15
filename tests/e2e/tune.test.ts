import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuditLog } from '../../src/audit/db.js';
import { isTrusted } from '../../src/policy/trust.js';
import { belayd, sandbox, type Sandbox } from './helpers.js';

let sb: Sandbox;
let policyFile: string;

beforeEach(() => {
  sb = sandbox();
  policyFile = path.join(sb.project, 'belayd.yaml');
  fs.writeFileSync(policyFile, '# my rules\nversion: 1\nextends: balanced\nrules: []\n');
});
afterEach(() => sb.cleanup());

async function approve(command: string, times: number): Promise<void> {
  const log = await AuditLog.open(sb.env.BELAYD_HOME!);
  try {
    for (let i = 0; i < times; i++) {
      const base = {
        session: 'claude-code:e2e',
        at: Date.now() + i,
        agent: 'claude-code',
        workspace: sb.project,
        cwd: sb.project,
        tool: 'Bash',
        toolUseId: `${command}-${i}`,
        kind: 'shell',
        input: JSON.stringify({ command }),
        verdict: 'ask',
      };
      log.append({ ...base, phase: 'pre', decision: 'allow', answeredBy: 'tty' });
      log.append({ ...base, phase: 'post', outcome: 'ran' });
    }
  } finally {
    log.close();
  }
}

describe('belayd tune', () => {
  it('adds an exact rule to a trusted project file and keeps it trusted', async () => {
    expect(belayd(sb, ['trust']).status).toBe(0);
    await approve('git push --force-with-lease origin feat', 3);

    const listed = belayd(sb, ['tune', '--dry-run']);
    expect(listed.stdout).toContain('1 suggestion');
    expect(listed.stdout).toContain('git push --force-with-lease origin feat');
    expect(listed.stdout).toContain('you approved it 3 times');
    expect(fs.readFileSync(policyFile, 'utf8')).not.toContain('learned-');

    const added = belayd(sb, ['tune', '--yes']);
    expect(added.status).toBe(0);
    expect(added.stdout).toContain('Added 1 rule to belayd.yaml');
    const text = fs.readFileSync(policyFile, 'utf8');
    expect(text).toContain('# my rules');
    expect(text).toContain('argv: [ git, push, --force-with-lease, origin, feat ]');
    expect(isTrusted(sb.env.BELAYD_HOME!, policyFile)).toBe(true);

    const exact = belayd(sb, ['check', 'git push --force-with-lease origin feat']);
    expect(exact.stdout).toMatch(/allow/);
    const other = belayd(sb, ['check', 'git push --force-with-lease origin main']);
    expect(other.stdout).toMatch(/ask/);

    // Nothing left to suggest: the policy no longer asks about it.
    expect(belayd(sb, ['tune', '--dry-run']).stdout).toContain('Nothing to suggest');
  });

  it('will not edit a project file you have not trusted', async () => {
    await approve('git push --force-with-lease origin feat', 3);
    const r = belayd(sb, ['tune', '--yes']);
    expect(r.stdout).toContain('is not trusted');
    expect(fs.readFileSync(policyFile, 'utf8')).not.toContain('learned-');
  });

  it('puts rules for every project in your own policy with --global', async () => {
    await approve('git push --force-with-lease origin feat', 3);
    const r = belayd(sb, ['tune', '--global', '--yes']);
    expect(r.status).toBe(0);
    const own = fs.readFileSync(path.join(sb.env.BELAYD_HOME!, 'belayd.yaml'), 'utf8');
    expect(own).toContain('learned-git-push-force-with-lease');
    expect(own).toContain('version: 1');
  });

  it('refuses to write from inside an agent session', async () => {
    expect(belayd(sb, ['trust']).status).toBe(0);
    await approve('git push --force-with-lease origin feat', 3);
    const r = belayd(sb, ['tune', '--yes'], { env: { CLAUDE_CODE_CHILD_SESSION: '1' } });
    expect(r.status).toBe(77);
    expect(fs.readFileSync(policyFile, 'utf8')).not.toContain('learned-');
  });
});
