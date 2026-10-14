# Security

## Reporting a problem

If you find a way past belayd that it should have caught, or a bug that weakens it, please report it privately: open a [GitHub security advisory](https://github.com/albert-canfield/belayd/security/advisories/new) on this repository. Include the command or tool call, the agent and version, your `belayd.yaml` if you changed it, and what belayd decided (`belayd check --explain '<command>'` prints this).

Commands that belayd simply judged too strictly or too loosely are welcome as normal issues. They become rows in the test corpus.

## What belayd is for

belayd catches mistakes made by an AI coding agent that you mostly trust, asks you before the risky ones, records what happened, and lets you undo file changes. It is a guardrail and a recorder. It is not a sandbox and does not try to contain hostile code.

## Threat model

**In scope.** belayd aims to stop, ask about, or record:

- destructive commands outside the project (`rm -rf ~`, disk formatting, recursive permission changes on system folders), including when they are hidden behind quoting, variables, `bash -c`, `eval`, substitutions, heredocs, pipes into interpreters, base64, aliases, functions, `find -exec`, `xargs`, `parallel`, `awk`'s `system()` and wrappers like `sudo`, `env`, `timeout`, `setsid`, `script`, `tmux`, `screen` or `at`
- code downloaded and run without anyone reading it (`curl | sh`, `bash <(curl ...)`, download then execute)
- reading files that hold secrets (`.env`, private keys, cloud credentials), including through symlinks inside the project
- secrets leaving the machine in commands, fetches and MCP arguments
- force pushes and other history rewrites, publishing, privilege escalation, infrastructure teardown
- changes to belayd's own policy and to agent hook settings, which could switch belayd off
- a hostile `belayd.yaml` shipped inside a repository: until you run `belayd trust`, a project policy can only add deny and ask rules, and they count only where they are stricter than your own policy's verdict. Its allow rules, `disable`, weaker presets and defaults, the allow rules of a stricter preset, `failMode: open`, approval settings other than a shorter timeout, and snapshot settings are ignored. A symlinked `belayd.yaml` does not inherit the trust of its target, and one that is a named pipe or a device is refused rather than read
- an agent answering its own approval request through `belayd approve`, the approval page's API or belayd's files

**Out of scope.** belayd does not protect against:

- **Programs the agent starts.** belayd sees the command, not what the program then does. `python build.py` is judged as that command. Inline code (`python -c`) cannot be analysed; the strict preset asks about it.
- **Actions outside the hooks.** belayd sees what the agent's hook system shows it. Files `@`-mentioned in a Claude Code prompt are read without a tool call. Claude Code mods that handle `tool.check` can override hook decisions unless belayd is installed through managed settings. Codex documents that some internal tool paths skip hooks. Remote MCP servers are covered only through the agent's hooks.
- **Settings that come with a repository.** An agent's own project settings (for example a repository's `.claude/settings.json`) can set environment variables for the session, `BELAYD_HOME` included, or switch hooks off entirely. Review those settings when you trust a folder in your agent. `belayd doctor` warns when `BELAYD_HOME` points inside the project.
- **An attacker with your account.** Anyone who can run commands as you can edit `belayd.yaml`, the hook settings or the audit database. The audit log's hash chain detects accidental and casual changes, not a determined rewrite.
- **Scripts that change after the check.** belayd reads `bash x.sh` at the moment the call is checked. A script that does not exist yet is asked about, but if another process rewrites an existing script between the check and the run, belayd does not see the new version.
- **Your environment.** A program given as `"$JAVA_HOME/bin/java"` is judged as `java`: for a short list of install locations (`JAVA_HOME`, `CARGO_HOME`, `NVM_DIR` and similar), belayd trusts the environment you started the agent with to point at the real program. A command that sets, reads into or exports one of them loses that trust, and so does any value the command itself builds at run time.
- **Commands built at run time.** When belayd cannot know a command or path statically (a variable from the environment, a command substitution as the program name), it asks instead of allowing. It cannot know what the command will turn out to be.

## How belayd fails

- Any error inside belayd blocks the action and says so.
- Hooks are installed with Claude Code's `onFailure: "block"` (version 2.1.295 and later) or with a shell guard that turns a crash into a block. Codex hooks always use the shell guard, because Codex fails open on hook errors. Copilot CLI blocks on hook errors but lets a timed-out hook through, so its hooks also get belayd's own deadline.
- belayd always answers a few seconds before the agent's hook timeout, so a slow approval ends in a deny from belayd rather than a timeout the agent might treat as "go ahead".
- Checking a call takes milliseconds. If it ever takes more than 20 seconds (a pathological command, a stuck file read), a watchdog thread stops the hook, which the installed hooks turn into a block. The analysis itself has fixed limits on how much code it reads; past them it asks.
- A broken or invalid `belayd.yaml` blocks every action until it is fixed. `belayd doctor` says what is wrong.
- Audit and snapshot failures never change a decision. They are written to `~/.belayd/errors.log` and reported by `belayd doctor`.

## How strong a held approval is

When an agent cannot show its own prompt (`claude -p`, Codex, Cursor, the MCP gateway), belayd holds the call and waits for a person. How strong that is depends on the channel:

- **`tty` and `web` (the default).** The request is a file in `~/.belayd/approvals`, answered by `belayd approve` or the local web page. belayd's rules deny the obvious ways for an agent to answer itself (running `belayd approve`, reading the page key, writing the files, calling the page's API), and `belayd approve` refuses to run inside an agent's tool call. But every program running as you can write files as you. An agent that deliberately starts a background program to watch the folder and write answers could approve itself. Treat these channels as protection against mistakes, not against an agent working to get around you.
- **`dialog`.** The waiting hook process shows a native dialog itself (macOS, or Linux with `zenity`) and only that click counts. Nothing is written to disk, so there is nothing to forge. With `approval: { channels: [native, dialog] }` this is the only way a held call is approved. A program with accessibility permissions to click on your screen could still answer it.
- **`native`.** In an attended Claude Code session, the question appears in Claude Code's own prompt, which is the strongest of the three.

## The approval page

`belayd ui` serves a page on `127.0.0.1` only. Each `belayd ui` creates a one-time link key that works once, for two minutes, and is swapped for a random session cookie held only in the server's memory, so nothing long-lived ends up in browser history. The cookie is `SameSite=Strict` and `HttpOnly`. The server requires a custom header on every request that changes anything, checks the `Origin` header, and rejects requests whose `Host` header is not `127.0.0.1` or `localhost` to stop DNS rebinding. The page has a strict Content-Security-Policy and loads nothing from the network.

## Data

Everything belayd stores lives in `~/.belayd` (or `$BELAYD_HOME`): the audit database, snapshots, pending approvals and a policy cache. Secrets found in commands are redacted before they are written to the audit log. Large file contents are stored as size and hash. belayd makes no network requests.
