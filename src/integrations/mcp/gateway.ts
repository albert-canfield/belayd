import { spawn } from 'node:child_process';
import readline from 'node:readline';
import { record, sessionKey, summarizeInput } from '../../audit/record.js';
import { addSessionWrites, sessionWrites } from '../../audit/session.js';
import { buildSubjects } from '../../policy/subjects.js';
import { evaluate } from '../../policy/engine.js';
import { actionLabel } from '../../policy/label.js';
import { loadPolicy } from '../../policy/load.js';
import type { Action, ActionContext } from '../../policy/types.js';
import { capture } from '../../snapshots/capture.js';
import { belaydHome, canonicalPath, findWorkspace, homeDir } from '../../util/paths.js';

export interface GatewayOptions {
  /** Server name used in rules (`mcp__<name>__<tool>`) and the audit log. */
  name: string;
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  cwd: string;
  binPath: string;
}

interface JsonRpc {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: {
    name?: string;
    arguments?: unknown;
    protocolVersion?: string;
    _meta?: Record<string, unknown>;
  };
  result?: { isError?: boolean };
  error?: unknown;
}

/** The first MCP revision whose results carry `resultType`. */
const MODERN_PROTOCOL = '2026-07-28';

/**
 * Runs an MCP server behind belayd. Messages are newline-delimited JSON-RPC on stdio.
 * Every tools/call from the client is checked first: denied calls are answered with an
 * error result explaining why, held calls wait for a person, the rest are forwarded.
 * Everything else passes through untouched, in both directions.
 */
export function runGateway(opts: GatewayOptions): Promise<number> {
  return new Promise((resolve) => {
    const stateDir = belaydHome(opts.env);
    const cwd = canonicalPath(opts.cwd);
    const workspace = findWorkspace(cwd);
    const home = canonicalPath(homeDir(opts.env));
    const session = sessionKey(
      'mcp',
      `${opts.name}-${new Date().toISOString().slice(0, 10)}-${process.pid}`,
    );
    let protocol = '';
    const inflight = new Map<string, { action: Action; ctx: ActionContext }>();

    const child = spawn(opts.command, opts.args, {
      cwd: opts.cwd,
      env: opts.env,
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    child.on('error', (err) => {
      process.stderr.write(`belayd mcp: could not start ${opts.command}: ${err.message}\n`);
      resolve(127);
    });

    const toClient = (line: string) => process.stdout.write(`${line}\n`);
    const toServer = (line: string) => {
      if (child.stdin.writable) child.stdin.write(`${line}\n`);
    };
    const blockedResult = (id: JsonRpc['id'], text: string) =>
      JSON.stringify({
        jsonrpc: '2.0',
        id,
        result: {
          content: [{ type: 'text', text }],
          isError: true,
          ...(protocol >= MODERN_PROTOCOL ? { resultType: 'complete' } : {}),
        },
      });

    // Server to client: pass every line through, note when a call we let through finishes.
    readline.createInterface({ input: child.stdout }).on('line', (line) => {
      toClient(line);
      try {
        const msg = JSON.parse(line) as JsonRpc;
        const key = msg.id === undefined || msg.id === null ? undefined : String(msg.id);
        const call = key ? inflight.get(key) : undefined;
        if (call && key) {
          inflight.delete(key);
          void finish(
            call,
            msg.error !== undefined || msg.result?.isError === true ? 'failed' : 'ran',
          );
        }
      } catch {
        // not JSON: nothing to record
      }
    });

    const finish = async (call: { action: Action; ctx: ActionContext }, outcome: string) => {
      const policy = await loadPolicy({ workspace, belaydHome: stateDir }).catch(() => undefined);
      const snapshot = policy ? capture(stateDir, policy, call.action, call.ctx) : undefined;
      if (outcome === 'ran') {
        addSessionWrites(
          stateDir,
          session,
          buildSubjects(call.action, call.ctx).flatMap((s) => s.writes),
        );
      }
      await record(stateDir, {
        session,
        phase: 'post',
        at: Date.now(),
        agent: 'mcp',
        workspace,
        cwd,
        tool: call.ctx.toolName,
        toolUseId: call.ctx.toolUseId,
        outcome,
        snapshot,
      });
    };

    const check = async (msg: JsonRpc, line: string) => {
      const tool = msg.params?.name ?? '';
      const action: Action = {
        kind: 'mcp',
        server: opts.name,
        tool,
        args: msg.params?.arguments ?? {},
      };
      const ctx: ActionContext = {
        agent: 'mcp',
        toolName: `mcp__${opts.name}__${tool}`,
        sessionId: session,
        toolUseId: String(msg.id),
        cwd,
        workspace,
        home,
      };
      const started = Date.now();
      const audit = (decision: string, extra: Record<string, string | undefined>) =>
        record(stateDir, {
          session,
          phase: 'pre',
          at: started,
          agent: 'mcp',
          workspace,
          cwd,
          tool: ctx.toolName,
          toolUseId: ctx.toolUseId,
          kind: 'mcp',
          label: actionLabel(action),
          input: summarizeInput(action.args),
          decision,
          durationMs: Date.now() - started,
          ...extra,
        });
      try {
        const policy = await loadPolicy({ workspace, belaydHome: stateDir });
        const decision = evaluate(action, ctx, policy, {
          belaydHome: stateDir,
          sessionWrites: sessionWrites(stateDir, session),
        });
        const rule = decision.ruleId ? ` [rule: ${decision.ruleId}]` : '';
        let verdict: string = decision.verdict;
        let reason = decision.reason + rule;
        let answeredBy: string | undefined;
        if (decision.verdict === 'ask') {
          const { resolveAsk } = await import('../../approval/resolve.js');
          const r = await resolveAsk({
            decision,
            action,
            ctx,
            policy,
            belaydHome: stateDir,
            env: opts.env,
            deadlineMs: policy.approval.timeoutMs,
            canAskNatively: false,
            binPath: opts.binPath,
          });
          verdict = r.verdict;
          reason = r.reason;
          answeredBy = r.answeredBy;
        }
        const facts = {
          verdict: decision.verdict,
          reason: decision.reason,
          ruleId: decision.ruleId,
          answeredBy,
        };
        if (verdict === 'deny' || verdict === 'ask') {
          await audit('deny', facts);
          const text = verdict === 'deny' && !answeredBy ? `Blocked by belayd: ${reason}` : reason;
          toClient(blockedResult(msg.id, text));
          return;
        }
        const snapshot = capture(stateDir, policy, action, ctx);
        await audit(verdict, { ...facts, snapshot });
        inflight.set(String(msg.id), { action, ctx });
        toServer(line);
      } catch (err) {
        await audit('deny', { verdict: 'error', reason: (err as Error).message });
        toClient(
          blockedResult(
            msg.id,
            `belayd hit an error and blocked this call to be safe: ${(err as Error).message}`,
          ),
        );
      }
    };

    const handle = (msg: JsonRpc, line: string) => {
      if (msg.method === 'initialize' && msg.params?.protocolVersion)
        protocol = msg.params.protocolVersion;
      const declared = msg.params?._meta?.['io.modelcontextprotocol/protocolVersion'];
      if (typeof declared === 'string') protocol = declared;
      if (msg.method === 'tools/call' && msg.id !== undefined && msg.id !== null) {
        void check(msg, line);
        return;
      }
      toServer(line);
    };

    // Client to server.
    const input = readline.createInterface({ input: process.stdin });
    input.on('line', (line) => {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        toServer(line);
        return;
      }
      if (Array.isArray(msg)) {
        // Old JSON-RPC batches: check each call on its own, forward the rest together.
        const rest = msg.filter((m: JsonRpc) => m?.method !== 'tools/call');
        for (const m of msg as JsonRpc[])
          if (m?.method === 'tools/call') handle(m, JSON.stringify(m));
        if (rest.length > 0) toServer(JSON.stringify(rest));
        return;
      }
      handle(msg as JsonRpc, line);
    });
    input.on('close', () => child.stdin.end());

    for (const signal of ['SIGINT', 'SIGTERM'] as const)
      process.on(signal, () => child.kill(signal));
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}
