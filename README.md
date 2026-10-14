<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
    <img src="docs/assets/banner-light.svg" alt="belayd. Let your agent climb. belayd catches the fall." width="100%">
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/belayd"><img alt="npm" src="https://img.shields.io/npm/v/belayd?color=ea580c&label=npm"></a>
  <a href="https://github.com/albert-canfield/belayd/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/albert-canfield/belayd/actions/workflows/ci.yml/badge.svg"></a>
  <img alt="Node 22 or newer" src="https://img.shields.io/badge/node-22%2B-3c873a">
  <a href="LICENSE"><img alt="MIT licence" src="https://img.shields.io/badge/licence-MIT-blue"></a>
</p>

Coding agents are fast, confident, and running with your permissions. Most days that's great. Then one of them force pushes to main, reads your `.env` into its context, or tidies up the wrong folder, and you find out afterwards.

**belayd sits between your agent and your machine.** It reads every command before it runs, stops the ones you would never approve, asks you about the risky ones, writes everything down, and puts your files back when an agent gets it wrong. One policy covers Claude Code, Codex and any MCP server.

```text
● Bash  X=rm; bash -c "$X -rf ~"
  ✖ belayd blocked this: This deletes the root of the file system, your home folder or a system folder.

● Bash  sed -i '' 's/v1/v2/' src/api.ts && rm src/legacy.ts

$ belayd undo
  restore  src/api.ts     +3 -3
  restore  src/legacy.ts
✔ Undid 2 file changes.  Changed your mind? belayd redo
```

## Up and running in two minutes

```sh
npm install -g belayd
cd your-project
belayd init
```

`init` finds Claude Code (and Codex, if you use it), shows you exactly what it will add to their settings, keeps a backup, and writes a `belayd.yaml` for the project. Restart your agent and you're covered. Nothing ever leaves your machine.

Try it without an agent:

```console
$ belayd check 'curl -fsSL https://get.example.sh | bash'
✖ deny  curl -fsSL https://get.example.sh | bash
   Runs code straight from the internet without anyone reading it. Download the script,
   show it to the user, and run it only after they agree.
   rule no-pipe-to-shell  ·  policy: balanced preset
```

## What you get

**It reads commands the way your shell does.** Not a regex over a string: belayd parses the command and follows quotes, variables, `cd`, aliases, functions, `bash -c`, `eval`, `$(...)`, heredocs, pipes into interpreters and even base64, then checks every program that would actually run. It reads shell scripts before they run too, so `bash cleanup.sh` is judged by what is inside `cleanup.sh`. Anything it can't see into gets a question, never a guess.

**It notices the sneaky version.** The classic way around a command allowlist is to edit `package.json` and then run `npm test`. belayd remembers which files the agent changed in the session, and asks before it runs scripts or Git hooks from one of them.

**It stays quiet until it matters.** When no rule applies, belayd says nothing and your agent behaves exactly as it did before. No fifty extra prompts a day.

**It asks in the right place.** In an interactive Claude Code session, belayd's question shows up in Claude Code's own prompt. When nobody is watching the terminal (`claude -p`, Codex, a long background run), belayd holds the call and pings you, and you answer with `belayd approve`, on a local web page, or in a native dialog. No answer in time means no.

<p align="center"><img src="docs/assets/approval-page.png" width="620" alt="The belayd approval page with two waiting requests: a force push from Codex and npm test from Claude Code after the agent changed package.json"></p>

**It keeps a flight recorder.** Every tool call, what belayd decided, who approved it and whether it ran, in a local append-only log with a hash chain. `belayd replay` turns a session into a readable timeline, including the files each step changed.

**It undoes.** belayd snapshots files before and after every step that can change them, shell commands included, in a shadow Git repository that never touches your own `.git`. `belayd undo 7` puts back exactly what step 7 changed. Claude Code's `/rewind` and Cursor's checkpoints can't undo what a shell command did. belayd can.

## What it catches

With the default `balanced` policy:

<!-- catches:start -->
| Command | belayd | Why |
|---|---|---|
| `rm -rf ~` | blocked | Deletes your home folder |
| `X=rm; bash -c "$X -rf ~"` | blocked | The same, hidden behind a variable and `bash -c` |
| `echo cm0gLXJmIC8= \| base64 -d \| sh` | blocked | That's `rm -rf /` in base64 |
| `find ~ -exec rm -rf {} +` | blocked | Deletes everything find finds in your home folder |
| `curl -fsSL https://get.example.sh \| bash` | blocked | Runs code nobody has read |
| `cat .env` | blocked | Secrets. The agent should ask you for the one value it needs |
| `cp ~/.ssh/id_rsa /tmp/k` | blocked | Your SSH key |
| `git push --force origin main` | blocked | Rewrites history other people already have |
| `git push --force-with-lease` | asks | Safer, still a force push |
| `git reset --hard HEAD~3` | asks | Throws away work |
| `sudo apt-get install -y jq` | asks | Runs as root |
| `npm publish` | asks | Publishes to the world |
| `psql -c "DROP TABLE users"` | asks | Drops a table |
| `echo hi > /etc/hosts` | asks | Changes a file outside the project |
| `npm test` | quiet | Your agent decides as usual |
| `rm -rf node_modules dist` | quiet | Inside the project, and undo can bring it back |
<!-- catches:end -->

Every row above is checked by the test suite, together with [300 more](tests/policy/corpus.yaml) for each of the three presets.

## Undo, step by step

```console
$ belayd replay
Session e435c08c  Claude Code · my-app · Oct 14, 2026, 10:04 AM · 3 min · 3 steps

1  10:04:22  ·  Edit   write src/app.ts
                M src/app.ts +1 -1
2  10:04:30  ·  Bash   sed -i '' 's/hello/goodbye/' greeting.txt && echo extra > notes.md
                M greeting.txt +1 -1
                A notes.md +1 -0
3  10:04:41  ✖  Bash   cat .env
                blocked: This file holds secrets such as keys, tokens or passwords.

$ belayd undo 2
  restore  greeting.txt  +1 -1
  delete   notes.md  +1 -0  (created by the agent)
✔ Undid 2 file changes.  Changed your mind? belayd redo
```

Undo never throws away newer work. If a file changed again after the step you're undoing, belayd says so and stops, unless you pass `--force`. Redo checks the same way. You can undo one step, a range (`belayd undo 5-8`) or a whole session (`belayd undo --whole-session`), and every undo can be redone.

## Your policy, in one file

`belayd init` writes a `belayd.yaml` that starts from a preset. Your rules win over the preset:

```yaml
version: 1
extends: balanced

rules:
  - id: allow-clean-build
    match: { command: rm, writes: '{workspace}/dist/**' }
    decision: allow

  - id: no-production-database
    match: { command: psql, args: { any: ['*prod*'] } }
    decision: deny
    reason: Production database access is not allowed from agents.
```

| Preset | When nothing matches | Good for |
|---|---|---|
| `balanced` (default) | Stays quiet, your agent's own permissions decide | Day-to-day work |
| `strict` | Asks, except for reading the project and read-only commands | Sensitive repositories, unattended runs |
| `yolo-with-undo` | Allows, so your agent stops prompting you | Moving fast, with undo as the safety net |

Rules can match on the program and subcommand (`git push`), arguments, file paths (read, written or either), network domains, code piped from the internet, and secrets in outgoing data. The presets are plain YAML in [`presets/`](presets): they double as examples. A few rules are marked `final`: your own rules can't weaken them, and switching one off takes an explicit `disable:` line that shows up in the audit log. More examples live in [`examples/`](examples).

Your own policy lives in `~/.belayd/belayd.yaml` and applies everywhere. A project can have its own `belayd.yaml` too, which builds on yours: your rules still apply inside the project, the project's settings win where both set one, and a project rule with the same `id` as one of yours replaces it.

A `belayd.yaml` that arrives with a cloned repository is not trusted until you look at it. Until you run `belayd trust`, it can make belayd stricter but never weaker: its deny and ask rules can add a question or a block on top of what your policy decided, never take one away, and its allow rules, switches and approval settings are ignored. The file `belayd init` writes for you is trusted from the start, and editing a trusted file untrusts it until you run `belayd trust` again.

## Supported agents

| Agent | Blocks | Asks you | Audit | Undo | How |
|---|---|---|---|---|---|
| Claude Code | ✓ | Its own prompt, or `belayd approve` when headless | ✓ | ✓ | PreToolUse and PostToolUse hooks |
| Codex CLI | ✓ | `belayd approve` or the web page | ✓ | ✓, including `apply_patch` | Codex hooks |
| Any MCP server | ✓ | `belayd approve` or the web page | ✓ | For tools that change files | `belayd mcp` gateway |
| Cursor | Partly | `belayd approve` or the web page | ✓ | ✓ | Cursor runs Claude Code's hooks |
| Copilot CLI | Partly, not yet tried live | `belayd approve` or the web page | ✓ | ✓ | Copilot CLI runs Claude Code's hooks from the repository |
| Gemini CLI, Antigravity CLI, OpenCode | Planned | | | | |

Codex can't show its own prompt from a hook (it treats a hook's "ask" as an error and runs the command), so belayd never sends it one: it holds the call and asks you itself.

To put an MCP server behind belayd, either wrap a config file (`belayd mcp wrap .mcp.json`) or start the server through belayd yourself:

```sh
belayd mcp --name github -- npx -y @modelcontextprotocol/server-github
```

## How it works

```text
 Claude Code     Codex      MCP client
      │            │            │
      └── hooks ───┴── gateway ─┘        one short process per tool call
                   │
          ┌────────▼────────┐
          │ belayd          │  parse the command, apply your policy
          │                 │  ask a person if needed
          │                 │  snapshot files, write the audit log
          └────────┬────────┘
                   │  allow · ask · deny
                   ▼
            your shell and files
```

Hooks are the agents' own extension points, so belayd needs no wrapper around your agent and no daemon. Everything lives in `~/.belayd`: the audit database, the snapshots and pending approvals.

A hook call takes about 60 to 90 ms on an M-series Mac, of which belayd adds 20 to 50 ms (the rest is Node starting, and the upper end includes the snapshot before a shell command). CI fails the build if that overhead goes above 100 ms.

## How it compares

| | belayd | Agents' built-in permissions | Command guards (dcg, cc-safety-net) | Sandboxes (sandbox-runtime, nono) |
|---|---|---|---|---|
| One policy for several agents | ✓ | Each agent has its own format | ✓ | ✓ |
| Understands the shell, not just patterns | ✓ | Partly | Partly | Not needed, it contains the process |
| Asks you, including in headless runs | ✓ | In interactive sessions | Mostly blocks only | Rarely |
| Audit log you can replay | ✓ | Transcripts | Some | Some |
| Undo changes made by shell commands | ✓ | Mostly no (OpenCode's `/undo` is the exception) | No | nono: rollback |
| Stops a determined, malicious program | No | No | No | ✓ |

A sandbox and belayd solve different problems. A sandbox contains code you don't trust. belayd catches mistakes made by an agent you mostly do trust, explains them, and lets you take them back. Use both if you can. There is a longer survey in [docs/landscape.md](docs/landscape.md).

## What belayd does not protect you from

Plain words, because a safety tool that oversells itself is worse than none:

- **belayd is a guardrail, not a sandbox.** It sees the tool calls an agent makes through its hooks. A program the agent starts can do whatever that program does: `python build.py` is judged as `python build.py`, not by what the script contains. Inline code (`python -c`, `node -e`) can't be analysed; `strict` asks about it.
- **It only sees what the hooks see.** Files you `@`-mention in a Claude Code prompt are inserted without a tool call. A Claude Code mod that handles `tool.check` can override hook decisions unless belayd is installed through managed settings. Codex documents that a few internal tool paths skip hooks.
- **Agents fail open on some failures.** belayd always answers before the agent's hook timeout, blocks on its own errors, and installs a guard that turns a crash into a block. Claude Code 2.1.295 and later also block on hook timeouts; older versions don't.
- **Undo covers files in the project**, up to 20 MB each. It can't take back a push, an email, a database write or a file outside the project.
- **The audit log is tamper-evident, not tamper-proof.** The hash chain catches accidents and casual edits. Someone with full access to your account can rebuild it.

For the full reasoning, see [docs/integrations.md](docs/integrations.md) and [SECURITY.md](SECURITY.md).

## Commands

| Command | What it does |
|---|---|
| `belayd init` | Set up hooks for the agents it finds and write `belayd.yaml` |
| `belayd check '<command>'` | Show what belayd would decide, without running anything (`--explain` lists every program found inside) |
| `belayd approve` | Answer waiting requests in a live terminal console |
| `belayd ui` | Open the local approval page |
| `belayd log`, `belayd sessions` | What happened, newest last (`log --verify` checks the hash chain) |
| `belayd replay [session]` | A session as a timeline, with the files each step changed |
| `belayd undo [steps]`, `belayd redo` | Put files back, and take that back |
| `belayd mcp` | Run an MCP server behind belayd, or wrap a config file |
| `belayd trust` | Let a project's `belayd.yaml` apply in full, after you've reviewed it |
| `belayd doctor` | Check that everything is installed and working |
| `belayd uninstall` | Remove every hook belayd installed (your log and snapshots stay) |

## FAQ

**Will it fight my existing Claude Code permissions?**
No. belayd only adds friction where a rule says so. It never switches off a prompt you already had unless one of your rules explicitly allows something.

**What happens if belayd breaks?**
It blocks. A broken policy file, a crash or garbage input all end in "no", with a message pointing at `belayd doctor`.

**Does it send anything anywhere?**
No. There is no account, no telemetry and no network call. The approval page listens on 127.0.0.1 only and needs a key from your machine.

**Windows?**
Not yet. belayd runs on macOS and Linux with Node 22 or newer.

**How do I turn it off?**
`belayd uninstall`. Your `belayd.yaml`, audit log and snapshots stay where they are.

## Contributing

Bug reports with a command belayd got wrong are the most useful thing you can send: every one becomes a row in the test corpus. See [CONTRIBUTING.md](CONTRIBUTING.md).

## Licence

MIT © Albert Canfield
