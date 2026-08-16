#!/usr/bin/env bash
# Diagnose why codex is not using the credential it was given (Linux / macOS).
#
# Read-only: it inspects and reports, and changes nothing.
#
# Usage:  ./diagnose.sh [--endpoint https://HOST:8443]

set -uo pipefail   # deliberately not -e: every probe must run even if one fails

ENDPOINT="${CODEX_CRED_ENDPOINT:-}"
[ "${1:-}" = "--endpoint" ] && ENDPOINT="${2:-}"

CODEX_DIR="${CODEX_HOME:-$HOME/.codex}"

echo "===== codex credential diagnosis ====="
echo

echo "[1] Environment variables that would hijack requests"
found=0
for var in OPENAI_BASE_URL OPENAI_API_KEY OPENAI_API_BASE CODEX_BASE_URL; do
  val="${!var:-}"
  if [ -n "$val" ]; then
    # May be a secret; show only the ends.
    if [ ${#val} -gt 24 ]; then
      echo "  $var = ${val:0:12}…${val: -6}"
    else
      echo "  $var = $val"
    fi
    found=1
  fi
done
[ "$found" -eq 0 ] && echo "  (none — clean)"
echo

echo "[2] codex config"
if [ -f "$CODEX_DIR/config.toml" ]; then
  if grep -qE '^\s*(base_url|model_provider|\[model_providers)' "$CODEX_DIR/config.toml"; then
    grep -nE '^\s*(base_url|model_provider|\[model_providers|wire_api|env_key)' "$CODEX_DIR/config.toml" | sed 's/^/  /'
  else
    echo "  (no custom provider/base_url — clean)"
  fi
else
  echo "  (no config.toml)"
fi
echo

echo "[3] Which credential is installed"
AUTH="$CODEX_DIR/auth.json"
if [ -f "$AUTH" ]; then
  node -e '
const fs = require("fs");
const d = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const t = d.tokens || {};
console.log("  auth_mode      =", d.auth_mode);
console.log("  OPENAI_API_KEY =", d.OPENAI_API_KEY ? "set  <- API-key mode, not a subscription" : "null (expected)");
const rt = t.refresh_token;
if (rt === undefined)   console.log("  refresh_token  = ABSENT     <- not from this system");
else if (rt === "")     console.log("  refresh_token  = empty      <- issued by this system (correct)");
else                    console.log("  refresh_token  = present    <- left by a manual codex login, not this system");
const at = t.access_token;
if (at && at.split(".").length >= 2) {
  try {
    const p = JSON.parse(Buffer.from(at.split(".")[1], "base64url").toString("utf8"));
    const days = (p.exp * 1000 - Date.now()) / 86400000;
    console.log("  access_token   =", days.toFixed(2), "days remaining", days <= 0 ? "<- EXPIRED" : "");
  } catch { console.log("  access_token   = unparseable exp"); }
} else {
  console.log("  access_token   = absent or not a JWT");
}
' "$AUTH" 2>/dev/null || echo "  (could not parse — is node installed?)"
  perms=$(stat -c '%a' "$AUTH" 2>/dev/null || stat -f '%Lp' "$AUTH" 2>/dev/null)
  echo "  file mode      = $perms $([ "$perms" = "600" ] || echo '<- expected 600')"
else
  echo "  (no auth.json — no credential installed)"
fi
echo

echo "[4] Network reachability from this shell"
probe() {
  # 405 on the codex endpoint means the request arrived (GET on a POST route),
  # which is the signal we want; 000 means it never got there.
  code=$(curl -s -k -o /dev/null -w '%{http_code}' --max-time 15 "$1" 2>/dev/null)
  case "$code" in
    405|200) verdict="reachable" ;;
    000)     verdict="UNREACHABLE — no proxy on this shell, or blocked" ;;
    *)       verdict="returned $code" ;;
  esac
  printf '  %-52s %s\n' "$1" "$verdict"
}
if command -v curl >/dev/null; then
  probe "https://chatgpt.com/backend-api/codex/responses"
  [ -n "$ENDPOINT" ] && probe "${ENDPOINT%/}/health"
  [ -z "$ENDPOINT" ] && echo "  (pass --endpoint to also probe the dispenser)"
else
  echo "  curl not found — cannot probe"
fi
echo

echo "[5] Versions"
echo "  node  = $(command -v node  >/dev/null && node -v            || echo 'not installed')"
echo "  codex = $(command -v codex >/dev/null && codex --version 2>&1 | head -1 || echo 'not installed')"
echo

echo "[6] Timer"
case "$(uname -s)" in
  Linux)
    if systemctl --user list-unit-files codex-credential.timer >/dev/null 2>&1; then
      systemctl --user list-timers codex-credential.timer --no-pager 2>/dev/null | sed -n '1,2p' | sed 's/^/  /'
    else
      PID_FILE="$HOME/.cache/claude-codex-gateway/codex-credential-loop.pid"
      LOOP="$HOME/.local/share/claude-codex-gateway/client-agent/refresh-loop.sh"
      pid=$([ -f "$PID_FILE" ] && [ ! -L "$PID_FILE" ] && cat "$PID_FILE" 2>/dev/null || true)
      args=''
      if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
        if [ -r "/proc/$pid/cmdline" ]; then args=$(tr '\0' ' ' < "/proc/$pid/cmdline")
        else args=$(ps -p "$pid" -o args= 2>/dev/null || true)
        fi
      fi
      if printf '%s' "$args" | grep -Fq -- "$LOOP"; then
        echo "  container refresh loop active (pid $pid)"
      else
        echo "  no systemd user timer or container refresh loop"
      fi
    fi ;;
  Darwin)
    # Captured, not piped into `grep -q`: under `set -o pipefail` an early-exiting
    # grep makes launchctl take SIGPIPE, and the pipeline reports 141 on a match —
    # so a loaded agent intermittently reads as "not loaded".
    AGENTS="$(launchctl list 2>/dev/null || true)"
    case "$AGENTS" in
      *com.claude-codex-gateway.codex-credential*) echo "  launchd agent loaded" ;;
      *) echo "  launchd agent not loaded" ;;
    esac ;;
esac
