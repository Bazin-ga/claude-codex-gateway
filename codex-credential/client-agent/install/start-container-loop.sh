#!/usr/bin/env bash
# Start the per-user credential refresh scheduler used when systemd is absent.
set -euo pipefail

DEST=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
RUNNER="${CODEX_CRED_RUNNER:-$DEST/run.sh}"
LOOP_NAME="${CODEX_CRED_LOOP_NAME:-codex-credential}"
LOOP_FORCE="${CODEX_CRED_LOOP_FORCE:-1}"
[[ "$LOOP_NAME" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]] || {
  echo "unsafe credential loop name" >&2
  exit 1
}
[[ "$LOOP_FORCE" == 0 || "$LOOP_FORCE" == 1 ]] || {
  echo "unsafe credential loop force mode" >&2
  exit 1
}
STATE_DIR="$HOME/.cache/claude-codex-gateway"
if [[ "$LOOP_NAME" == codex-credential ]]; then
  LOOP="$DEST/refresh-loop.sh"
else
  LOOP="$DEST/refresh-loop-$LOOP_NAME.sh"
fi
PID_FILE="$STATE_DIR/$LOOP_NAME-loop.pid"
LOG_FILE="$STATE_DIR/$LOOP_NAME-loop.log"

running() {
  [[ -f "$PID_FILE" && ! -L "$PID_FILE" ]] || return 1
  pid=$(<"$PID_FILE")
  [[ $pid =~ ^[0-9]+$ ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  if [[ -r "/proc/$pid/cmdline" ]]; then
    tr '\0' ' ' < "/proc/$pid/cmdline" | grep -Fq -- "$LOOP"
  else
    ps -p "$pid" -o args= 2>/dev/null | grep -Fq -- "$LOOP"
  fi
}

[[ -f "$RUNNER" && ! -L "$RUNNER" && -x "$RUNNER" ]] || {
  echo "credential runner is missing or unsafe: $RUNNER" >&2
  exit 1
}

if [[ -e "$STATE_DIR" || -L "$STATE_DIR" ]]; then
  [[ -d "$STATE_DIR" && ! -L "$STATE_DIR" ]] || { echo "unsafe scheduler state directory: $STATE_DIR" >&2; exit 1; }
else
  mkdir -p "$STATE_DIR"
fi
chmod 700 "$STATE_DIR"
for target in "$LOOP" "$PID_FILE" "$LOG_FILE"; do
  [[ ! -L "$target" ]] || { echo "refusing symlinked scheduler state: $target" >&2; exit 1; }
done
printf -v runner_q '%q' "$RUNNER"
printf -v log_q '%q' "$LOG_FILE"
configuration_matches() {
  [[ -f "$LOOP" && ! -L "$LOOP" ]] || return 1
  grep -Fqx -- "runner=$runner_q" "$LOOP" &&
    grep -Fqx -- "force=$LOOP_FORCE" "$LOOP"
}
if running; then
  if configuration_matches; then
    echo "registered container refresh loop (already running, pid $(<"$PID_FILE"))"
    exit 0
  fi
  old_pid="$pid"
  echo "reconfiguring container refresh loop"
  kill "$old_pid" 2>/dev/null || true
  for ((attempt=0; attempt<50; attempt++)); do
    kill -0 "$old_pid" 2>/dev/null || break
    sleep 0.1
  done
  kill -0 "$old_pid" 2>/dev/null && {
    echo "existing credential loop did not stop safely" >&2
    exit 1
  }
fi

umask 077
cat > "$LOOP" <<LOOP_EOF
#!/bin/sh
set -u
runner=$runner_q
log=$log_q
force=$LOOP_FORCE
child=''
stop() {
  [ -z "\$child" ] || kill "\$child" 2>/dev/null || true
  exit 0
}
trap stop HUP INT TERM
while :; do
  sleep 43200 &
  child=\$!
  wait "\$child" || exit \$?
  child=''
  if [ "\$force" = 1 ]; then
    "\$runner" --force >> "\$log" 2>&1 || true
  else
    "\$runner" >> "\$log" 2>&1 || true
  fi
done
LOOP_EOF
chmod 700 "$LOOP"
touch "$LOG_FILE"
chmod 600 "$LOG_FILE"

nohup "$LOOP" >> "$LOG_FILE" 2>&1 </dev/null &
pid=$!
printf '%s\n' "$pid" > "$PID_FILE"
chmod 600 "$PID_FILE"
sleep 0.1
running || { echo "failed to start the container refresh loop" >&2; exit 1; }
echo "registered container refresh loop (pid $pid, every 12 hours)"
