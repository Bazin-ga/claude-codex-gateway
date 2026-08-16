#!/usr/bin/env bash
set -euo pipefail

ROOT=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/codex-client-install-test.XXXXXX")
HOME_DIR="$TEST_ROOT/home"
FAKE_BIN="$TEST_ROOT/bin"
PID_FILE="$HOME_DIR/.cache/claude-codex-gateway/codex-credential-loop.pid"

cleanup() {
  if [[ -f "$PID_FILE" ]]; then
    pid=$(<"$PID_FILE")
    [[ $pid =~ ^[0-9]+$ ]] && kill "$pid" 2>/dev/null || true
  fi
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

mkdir -p "$HOME_DIR" "$FAKE_BIN"
cat > "$FAKE_BIN/node" <<'FAKE_NODE'
#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} == -v || ${1:-} == --version ]]; then
  printf '%s\n' 'v22.0.0'
  exit 0
fi
mkdir -p "$HOME/.codex"
printf '%s\n' '{"tokens":{"access_token":"test"}}' > "$HOME/.codex/auth.json"
FAKE_NODE
cat > "$FAKE_BIN/codex" <<'FAKE_CODEX'
#!/usr/bin/env bash
printf '%s\n' 'codex-cli test'
FAKE_CODEX
cat > "$FAKE_BIN/systemctl" <<'FAKE_SYSTEMCTL'
#!/usr/bin/env bash
exit 1
FAKE_SYSTEMCTL
chmod +x "$FAKE_BIN/node" "$FAKE_BIN/codex" "$FAKE_BIN/systemctl"

run_install() {
  HOME="$HOME_DIR" PATH="$FAKE_BIN:/usr/bin:/bin" \
    bash "$ROOT/install/install.sh" \
      --endpoint https://127.0.0.1:8443 \
      --token test-device-token \
      --cert-pin "$(printf 'a%.0s' {1..64})"
}

run_install > "$TEST_ROOT/first.out"
[[ -f "$PID_FILE" && ! -L "$PID_FILE" ]] || { echo 'fallback pid file missing' >&2; exit 1; }
pid=$(<"$PID_FILE")
[[ $pid =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null || { echo 'fallback loop is not running' >&2; exit 1; }
tr '\0' ' ' < "/proc/$pid/cmdline" | grep -Fq -- "$HOME_DIR/.local/share/claude-codex-gateway/client-agent/refresh-loop.sh"
[[ $(stat -c %a "$PID_FILE") == 600 ]] || { echo 'fallback pid file mode is not 600' >&2; exit 1; }
[[ $(stat -c %a "$HOME_DIR/.cache/claude-codex-gateway/codex-credential-loop.log") == 600 ]] || { echo 'fallback log mode is not 600' >&2; exit 1; }
grep -Fq 'registered container refresh loop' "$TEST_ROOT/first.out"

run_install > "$TEST_ROOT/second.out"
[[ $(<"$PID_FILE") == "$pid" ]] || { echo 'idempotent install replaced a healthy loop' >&2; exit 1; }
grep -Fq 'already running' "$TEST_ROOT/second.out"

echo 'client-agent installer: container fallback loop passed'
