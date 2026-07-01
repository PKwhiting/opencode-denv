# denv — lock opencode sessions to remote droplets

Run **one** opencode instance with each **chat session** pinned to its own
DigitalOcean droplet. A session picks its environment by its **title**: title a
session so it contains a configured env name (e.g. `dev1`), and every shell
command in that session runs on that droplet over SSH. Your local MCPs/skills
are shared across all sessions; sessions stay isolated from each other.

## Two approaches in this repo

- **Plugin (recommended) — `plugin/denv.ts`:** many env-locked sessions inside
  one opencode instance, routed by session title. This is the one you want.
- **Launcher (alternative) — `denv` + `bin/remote-shell`:** one separate,
  fully-locked opencode instance per env, each in its own terminal/tmux window.
  Simpler model, but one instance per environment.

The rest of this file covers the plugin.

## How it works

- The `tool.execute.before` hook fires before every tool call with the
  `sessionID`. The plugin looks up that session's title, matches it to a
  configured env, and rewrites each `bash` command to `denv-run <env> '<cmd>'`.
  The `denv-run` helper does the SSH (base64-wrapped so quoting can't break;
  ControlMaster reused for speed), so the agent sees a clean wrapper instead of
  a raw ssh/base64 blob it would otherwise try to "avoid".
- opencode's file tools (`read`/`write`/`edit`/`grep`/`glob`/`list`) can't be
  redirected to a remote, so on a bound session they're **denied** — the agent
  does file work through the (remote) shell. MCP/web tools run locally.
- Sessions whose title matches no env run **normally (local)**. Set
  `DENV_STRICT=1` to deny those instead (good for a droplets-only instance).
- Two guards stop the agent getting confused about local-vs-remote:
  - **System note (every turn):** for a bound session the plugin injects a
    system instruction telling the model it's already inside the env, so it
    runs commands directly and never tries to `ssh` in.
  - **Anti-double-ssh:** any command that tries to `ssh` back into the env's
    own host is blocked with a clear error (it would otherwise nest ssh and
    fail with `Permission denied (publickey)`).

No global opencode config changes: file tools are disabled per bound session by
the plugin, not globally — so other local sessions are unaffected.

## Install

1. Env map — copy and edit:
   ```
   cp ~/Desktop/PROJECTS/opencode-denv/denv-envs.example.json ~/.config/opencode/denv-envs.json
   # edit it: add your droplets ({ "<name>": { "host": "root@ip", "workspace": "/" } })
   ```
2. Plugin — link it into opencode's global plugin dir (copy if symlinks aren't followed):
   ```
   mkdir -p ~/.config/opencode/plugins
   ln -sf ~/Desktop/PROJECTS/opencode-denv/plugin/denv.ts ~/.config/opencode/plugins/denv.ts
   ```
3. Helper — the plugin shells out to `denv-run` (it does the SSH). Link it where
   the plugin looks by default:
   ```
   ln -sf ~/Desktop/PROJECTS/opencode-denv/denv-run ~/.config/opencode/denv-run
   ```
   (Optional: also put it on PATH — e.g. `ln -sf … ~/.opencode/bin/denv-run` — and
   set `DENV_RUN=denv-run` for a shorter command display.)
4. Restart opencode.

Prereq: key-based SSH to each droplet — `ssh root@<ip> hostname` must work
without a password prompt.

## Use

1. Start opencode (one instance).
2. Create a chat session and **title it after an env** — e.g. `dev1` (the title
   just has to contain the name). Its shell commands now run on `dev1`.
3. Create another session titled `dev2`, a third `dev3`, etc. — all in the same
   instance, each locked to its own droplet, running concurrently.
4. In a session, ask the agent to run `hostname` — it should print that
   droplet's name.

## Verify on first run

- Title a session `dev1`, ask it to run `hostname` → expect the droplet's name
  (`snapshots-…`), not your Mac.
- Open a second session titled `dev2` and confirm its commands go to `dev2`, not
  `dev1` — proving per-session isolation.
- opencode's logs should show `denv: session <id> -> dev1` lines.
- If a session runs locally when you expected remote, its title didn't match —
  make sure it contains the env name exactly as spelled in `denv-envs.json`.

## Known limitations

- **File edits go through the shell** (`cat`/`sed`/heredocs) — fine for
  command/build/test/git work, clunkier for big refactors.
- **Each command is a fresh remote shell** — `cd`, env vars, and venvs don't
  persist across separate tool calls (each command starts in the workspace dir).
  Chain dependent steps in one command.
- **Interactive/TTY commands** aren't supported over the per-command forward.
- **Restart opencode after editing `denv-envs.json`** (loaded once at startup).

## Verified

The exact SSH command the plugin generates was tested against a live droplet:
`hostname`, `pwd`, and a root-filesystem listing all ran on the droplet, not
locally. The remaining first-run checks (above) confirm opencode's hook
behavior on your build.
