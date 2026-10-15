// The belayd GitHub Action, second half: runs when the job ends and puts what every
// agent did, and what belayd decided, in the job summary.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const home = process.env.STATE_home || process.env.BELAYD_HOME;
const env = { ...process.env, BELAYD_HOME: home, NO_COLOR: '1', COLUMNS: '160' };
const belayd = (...args) => execFileSync('belayd', args, { env, encoding: 'utf8' });
const NAMES = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  copilot: 'Copilot CLI',
  gemini: 'Gemini CLI',
  opencode: 'OpenCode',
  mcp: 'MCP client',
};

try {
  const sessions = JSON.parse(belayd('sessions', '--all', '--json'));
  const events = JSON.parse(belayd('log', '--all', '--json', '--limit', '100000'));
  const pre = events.filter((e) => e.phase === 'pre');
  const blocked = pre.filter((e) => e.decision === 'deny').length;
  const asked = pre.filter((e) => e.verdict === 'ask').length;

  const lines = ['## belayd', ''];
  if (sessions.length === 0) lines.push('No agent tool calls in this job.');
  else {
    lines.push(
      `${pre.length} tool ${pre.length === 1 ? 'call' : 'calls'} checked in ${sessions.length} agent ${sessions.length === 1 ? 'session' : 'sessions'}: ` +
        `**${blocked} blocked**, ${asked} asked about (in CI a question is a no unless the policy says otherwise).`,
      '',
    );
    for (const s of sessions) {
      const replay = belayd('replay', s.session).trimEnd();
      lines.push(
        `<details><summary>${NAMES[s.agent] ?? s.agent} · session ${s.session.replace(/^[^:]+:/, '').slice(0, 8)}</summary>`,
        '',
        '```text',
        replay,
        '```',
        '',
        '</details>',
        '',
      );
    }
  }
  if (process.env.GITHUB_STEP_SUMMARY)
    fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${lines.join('\n')}\n`);
  else console.log(lines.join('\n'));

  if (blocked > 0)
    console.log(
      `::warning::belayd blocked ${blocked} tool ${blocked === 1 ? 'call' : 'calls'} in this job.`,
    );
  if ((process.env['INPUT_FAIL-ON-BLOCK'] ?? '').trim() === 'true' && blocked > 0)
    process.exitCode = 1;
} catch (err) {
  console.log(`::warning::belayd could not write its summary: ${err.message}`);
}
