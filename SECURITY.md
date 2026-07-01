# Security

`opencode-denv` is designed for trusted development environments. It forwards
agent-generated shell commands to remote hosts over SSH, so the selected hosts
should be disposable or otherwise safe for agent-driven work.

## Do not commit real environment maps

Keep real hostnames, usernames, workspace paths, and internal network details in
local-only files:

- `~/.config/opencode/denv-envs.json` for plugin mode.
- `envs.conf` for launcher mode.

The repository intentionally ignores `envs.conf`, `denv-envs.json`, `.env`, and
`.env.*`. Use the checked-in `*.example` files for documentation and onboarding.

## SSH assumptions

- Use key-based SSH only.
- Avoid production, staging, customer-data, or shared environments unless they
  are explicitly approved for autonomous agent operations.
- Review remote shell history and git diffs before keeping any agent-produced
  changes.

## Local versus remote execution

In plugin-bound sessions, `bash` is routed to the selected remote host and local
file tools are denied. MCP tools, web tools, and other non-shell tools still run
from the local opencode process.

## Reporting issues

Open a private issue or contact the repository owner if a bug could expose local
files, secrets, SSH configuration, or unintended remote hosts.
