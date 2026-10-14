import module from 'node:module';

// Hooks run once per tool call, so startup time matters. The compile cache makes
// every run after the first one skip parsing and compiling belayd's JavaScript.
module.enableCompileCache?.();

const [command, ...rest] = process.argv.slice(2);

if (command === 'hook') {
  const { runHook } = await import('./hook/run.js');
  await runHook(rest);
} else if (command === 'mcp') {
  const { mcpCommand } = await import('./integrations/mcp/cli.js');
  process.exitCode = await mcpCommand(rest);
} else {
  const { runCli } = await import('./cli/index.js');
  await runCli(process.argv);
}
