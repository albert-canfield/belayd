import { Command } from 'commander';
import pc from 'picocolors';
import { PolicyError } from '../policy/load.js';
import { version } from '../version.js';
import { check } from './check.js';

export async function runCli(argv: string[]): Promise<void> {
  const program = new Command()
    .name('belayd')
    .description('One policy, one audit trail and one undo button for every AI coding agent.')
    .version(version, '-v, --version')
    .showHelpAfterError();

  program
    .command('check')
    .description(
      'Check a command (or a read, write or fetch) against your policy without running it',
    )
    .argument('[command...]', 'shell command to check, quoted')
    .option('--read <path>', 'check reading a file instead')
    .option('--write <path>', 'check writing a file instead')
    .option('--fetch <url>', 'check fetching a URL instead')
    .option('--cwd <dir>', 'pretend the command runs in this directory')
    .option('--policy <file>', 'use this policy file')
    .option(
      '--preset <name>',
      'use a preset and ignore policy files (balanced, strict, yolo-with-undo)',
    )
    .option('--explain', 'show every command found inside, with its verdict')
    .option('--json', 'print the decision as JSON')
    .action(async (words: string[], opts) => {
      process.exitCode = await check(words, opts);
    });

  program
    .command('init')
    .description('Set up belayd for the agents on this machine')
    .option('--preset <name>', 'policy preset for the new belayd.yaml', 'balanced')
    .option('--global', 'install into your user-level agent settings instead of this project')
    .option(
      '--agent <names>',
      'which agents to set up: claude-code, codex (default: the ones found)',
    )
    .option(
      '--claude-config-dir <dir>',
      'Claude Code config directory (default: $CLAUDE_CONFIG_DIR or ~/.claude)',
    )
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (opts) => {
      const { init } = await import('./init.js');
      process.exitCode = await init(opts);
    });

  program
    .command('uninstall')
    .description('Remove every hook belayd installed')
    .option('--global', 'remove from your user-level agent settings')
    .option('--agent <names>', 'only these agents: claude-code, codex')
    .option('--claude-config-dir <dir>', 'Claude Code config directory')
    .option('-y, --yes', 'do not ask for confirmation')
    .action(async (opts) => {
      const { uninstall } = await import('./init.js');
      process.exitCode = await uninstall(opts);
    });

  program
    .command('log')
    .description('Show what agents did in this project and what belayd decided')
    .option('--all', 'every project, not just this one')
    .option('--session <id>', 'one session only')
    .option('--limit <n>', 'how many events', '50')
    .option('--only <verdict>', 'only deny, ask, allow or pass')
    .option('--verify', 'check that no event was changed or removed')
    .option('--json', 'print events as JSON')
    .action(async (opts) => {
      const { log } = await import('./audit.js');
      process.exitCode = await log(opts);
    });

  program
    .command('sessions')
    .description('List agent sessions belayd has seen')
    .option('--all', 'every project, not just this one')
    .option('--limit <n>', 'how many sessions', '20')
    .option('--json', 'print sessions as JSON')
    .action(async (opts) => {
      const { sessions } = await import('./audit.js');
      process.exitCode = await sessions(opts);
    });

  program
    .command('replay')
    .description('Replay a session as a readable timeline (default: the latest in this project)')
    .argument('[session]', 'session id, or the first few characters of it')
    .option('--all', 'pick the latest session from any project')
    .option('--json', 'print the raw events as JSON')
    .action(async (id: string | undefined, opts) => {
      const { replay } = await import('./audit.js');
      process.exitCode = await replay(id, opts);
    });

  program
    .command('undo')
    .description('Put back files an agent changed (default: the last step that changed files)')
    .argument('[steps]', 'a step number, a range like 5-8, or a list like 5,7')
    .option('--session <id>', 'a session other than the latest one in this project')
    .option('--whole-session', 'undo every change the session made')
    .option('--dry-run', 'show what would change without touching anything')
    .option('--diff', 'show the diff of each file')
    .option('--force', 'undo even if the files changed again later')
    .action(async (steps: string | undefined, opts) => {
      const { undo } = await import('./undo.js');
      process.exitCode = await undo(steps, opts);
    });

  program
    .command('redo')
    .description('Reverse the most recent belayd undo in this project')
    .action(async () => {
      const { redo } = await import('./undo.js');
      process.exitCode = await redo();
    });

  program
    .command('gc')
    .description('Delete audit events older than a number of days')
    .option('--older-than <days>', 'for example 30d', '30d')
    .action(async (opts) => {
      const { gc } = await import('./audit.js');
      process.exitCode = await gc(opts);
    });

  program
    .command('trust')
    .description('Let a project belayd.yaml apply in full, after you have reviewed it')
    .argument('[file]', 'policy file (default: belayd.yaml in this project)')
    .option('--revoke', 'stop trusting it')
    .action(async (file: string | undefined, opts) => {
      const { trust } = await import('./trust.js');
      process.exitCode = await trust(file, opts);
    });

  program
    .command('approve')
    .description('Answer agents waiting for your approval (live console)')
    .argument('[id]', 'answer one request directly, with --allow or --deny')
    .option('--allow', 'allow the request')
    .option('--deny', 'deny the request')
    .option('--list', 'print what is waiting and exit')
    .option('--json', 'print what is waiting as JSON and exit')
    .action(async (id: string | undefined, opts) => {
      const { approve } = await import('./approve.js');
      process.exitCode = await approve(id, opts);
    });

  program
    .command('ui')
    .description('Open the local approval page in your browser')
    .option('--port <port>', 'port to listen on (default 23529)')
    .option('--no-open', 'print the link without opening a browser')
    .option('--serve', 'run the page server in the foreground')
    .action(async (opts) => {
      const { ui } = await import('./ui.js');
      process.exitCode = await ui(opts);
    });

  program
    .command('mcp')
    .description('Run an MCP server behind belayd: belayd mcp --name <server> -- <command...>')
    .helpOption(false)
    .allowUnknownOption()
    .argument('[args...]')
    .action(() => {
      // Handled before the CLI loads (see bin.ts); listed here for --help.
    });

  program
    .command('doctor')
    .description('Check that belayd is installed and working')
    .action(async () => {
      const { doctor } = await import('./doctor.js');
      process.exitCode = await doctor();
    });

  program
    .command('presets')
    .description('List the built-in policy presets')
    .action(async () => {
      const { listPresets, presetsDir } = await import('../policy/load.js');
      for (const name of listPresets()) console.log(name);
      console.log(pc.dim(`\nRead them in ${presetsDir()}`));
    });

  try {
    await program.parseAsync(argv);
  } catch (err) {
    if (err instanceof PolicyError) {
      console.error(pc.red('Your belayd policy has a problem:'));
      console.error(err.message);
      process.exitCode = 78;
      return;
    }
    throw err;
  }
}
