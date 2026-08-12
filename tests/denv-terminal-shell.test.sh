#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TEMP_DIR"' EXIT

cat >"$TEMP_DIR/fake-denv-run" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail
printf 'env=%s\ncommand=%s\n' "$1" "$2"
EOF
chmod +x "$TEMP_DIR/fake-denv-run"

remote_output="$({
  DENV_TARGET_ENV="dev-environ-7" \
  DENV_RUN="$TEMP_DIR/fake-denv-run" \
  "$ROOT/denv-terminal-shell" -c "printf 'quoted value' && pwd"
})"

[[ "$remote_output" == *"env=dev-environ-7"* ]]
[[ "$remote_output" == *"command=printf 'quoted value' && pwd"* ]]

local_output="$({
  DENV_TARGET_ENV="" \
  DENV_REAL_SHELL="/usr/bin/bash" \
  "$ROOT/denv-terminal-shell" -c "printf 'local value'"
})"

[[ "$local_output" == "local value" ]]

printf 'denv-terminal-shell tests passed\n'
