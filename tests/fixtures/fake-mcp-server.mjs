// A tiny stdio MCP server for tests. It really writes files for write_file, so the
// gateway's snapshots and undo can be checked end to end.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const msg = JSON.parse(line);
  if (msg.id === undefined) return; // notification
  if (msg.method === 'initialize') {
    return send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        protocolVersion: msg.params.protocolVersion,
        capabilities: { tools: {} },
        serverInfo: { name: 'fake', version: '1' },
      },
    });
  }
  if (msg.method === 'tools/list') {
    return send({
      jsonrpc: '2.0',
      id: msg.id,
      result: {
        tools: ['read_file', 'write_file', 'execute_command', 'echo'].map((name) => ({
          name,
          inputSchema: { type: 'object' },
        })),
      },
    });
  }
  if (msg.method === 'tools/call') {
    const { name, arguments: args } = msg.params;
    if (name === 'write_file') {
      fs.mkdirSync(path.dirname(path.resolve(args.path)), { recursive: true });
      fs.writeFileSync(path.resolve(args.path), args.content);
    }
    return send({
      jsonrpc: '2.0',
      id: msg.id,
      result: { content: [{ type: 'text', text: `ok ${name}` }] },
    });
  }
  send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'unknown method' } });
});
