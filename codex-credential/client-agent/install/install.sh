#!/usr/bin/env bash
# Install the Codex credential agent on Linux or macOS.
#
# Installs the agent, fetches a credential immediately, and registers a timer
# (systemd user timer on Linux, launchd agent on macOS) so the credential stays
# fresh without further attention.
#
# Usage:
#   ./install.sh --endpoint https://HOST:8443 --token <token> --cert-pin <pin>
#
# Everything is scoped to the invoking user. Nothing here needs root.

set -euo pipefail

ENDPOINT="" TOKEN="" CERT_PIN=""
DEST="${CODEX_CRED_AGENT_DIR:-$HOME/.local/share/claude-codex-gateway/client-agent}"

usage() {
  cat <<'USAGE'
usage: ./install.sh --endpoint <url> --token <token> --cert-pin <sha256>

  --endpoint   dispenser base URL, e.g. https://203.0.113.10:8443
  --token      this machine's bearer token (from add-client.js)
  --cert-pin   SHA-256 of the dispenser's certificate (from gen-cert.sh)
  --dir        where to install the agent (default ~/.local/share/claude-codex-gateway/client-agent)
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --endpoint) ENDPOINT="${2:?--endpoint needs a value}"; shift 2 ;;
    --token)    TOKEN="${2:?--token needs a value}"; shift 2 ;;
    --cert-pin) CERT_PIN="${2:?--cert-pin needs a value}"; shift 2 ;;
    --dir)      DEST="${2:?--dir needs a value}"; shift 2 ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

missing=()
[ -n "$ENDPOINT" ] || missing+=(--endpoint)
[ -n "$TOKEN" ]    || missing+=(--token)
[ -n "$CERT_PIN" ] || missing+=(--cert-pin)
if [ ${#missing[@]} -gt 0 ]; then
  echo "missing required argument(s): ${missing[*]}" >&2
  usage >&2
  exit 2
fi

SRC_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$(uname -s)" in
  Linux)  PLATFORM=linux  ;;
  Darwin) PLATFORM=macos  ;;
  *) echo "unsupported platform: $(uname -s) — see install/README.md" >&2; exit 1 ;;
esac
echo "platform: $PLATFORM"

# --- prerequisites -----------------------------------------------------------
# Node ships with codex (an npm package), so a machine that can run codex
# already has it. Checking anyway gives a clear message instead of a stack trace.
command -v node >/dev/null || { echo "node not found — install Node 20+ first" >&2; exit 1; }
echo "node: $(node -v)"

if command -v codex >/dev/null; then
  echo "codex: $(codex --version 2>&1 | head -1)"
else
  echo "codex: NOT INSTALLED — install it with: npm install -g @openai/codex" >&2
  echo "       (the credential will still be installed, but nothing will consume it yet)" >&2
fi

# --- warn about anything that would hijack codex's requests ------------------
# A third-party API relay configured through the environment or config.toml takes
# precedence over the subscription credential, so codex would keep talking to the
# relay and the credential installed here would never be used. Seen in the wild.
hijack=0
for var in OPENAI_BASE_URL OPENAI_API_KEY; do
  if [ -n "${!var:-}" ]; then
    echo "WARNING: $var is set — codex may bypass the subscription credential" >&2
    hijack=1
  fi
done
CODEX_CFG="${CODEX_HOME:-$HOME/.codex}/config.toml"
if [ -f "$CODEX_CFG" ] && grep -qE '^\s*(base_url|model_provider)\s*=' "$CODEX_CFG"; then
  echo "WARNING: $CODEX_CFG sets base_url/model_provider — codex may bypass the credential" >&2
  hijack=1
fi
[ "$hijack" -eq 0 ] && echo "no hijacking config found"

# --- install the agent -------------------------------------------------------
echo "installing agent to $DEST"
mkdir -p "$DEST"
# When the agent is invoked from the directory it is being installed into, the
# copy below is a self-copy: `cp x x` exits non-zero on both BSD ("are
# identical") and GNU ("are the same file") and, under `set -e`, aborts the
# install before the credential is ever fetched. That is exactly the shape a
# staged installer takes — it copies the agent into $DEST first, then runs this
# script from there with `--dir $DEST`. The files are already in place in that
# case, so there is nothing to copy.
# Compare resolved physical paths, not the strings: a trailing slash or a
# symlinked $HOME would otherwise hide the collision and reintroduce the abort.
if [ "$(cd "$SRC_DIR" && pwd -P)" = "$(cd "$DEST" && pwd -P)" ]; then
  echo "  agent already in place (source and destination are the same) — copy skipped"
else
  # Copy what the agent actually needs, and only if it exists — pull.js is
  # self-contained today but may grow a lib/ later; neither shape should break.
  cp "$SRC_DIR/pull.js" "$SRC_DIR/package.json" "$DEST/"
  if [ -d "$SRC_DIR/lib" ]; then
    mkdir -p "$DEST/lib"
    cp -R "$SRC_DIR/lib/." "$DEST/lib/"
  fi
  if [ -d "$SRC_DIR/install" ]; then
    mkdir -p "$DEST/install"
    cp -R "$SRC_DIR/install/." "$DEST/install/"
  fi
fi


# Credentials live in a mode-600 env file rather than the unit/plist, so they are
# not exposed to anyone able to read the service definition.
ENV_FILE="$HOME/.config/codex-credential.env"
mkdir -p "$(dirname "$ENV_FILE")"
umask 077
cat > "$ENV_FILE" <<EOF
CODEX_CRED_ENDPOINT=$ENDPOINT
CODEX_CRED_TOKEN=$TOKEN
CODEX_CRED_CERT_PIN=$CERT_PIN
EOF
chmod 600 "$ENV_FILE"
echo "wrote $ENV_FILE (mode 600)"

# A wrapper that EXPORTS the env file. Sourcing alone would only set shell
# variables, which a child node process never sees — the bug this avoids.
# launchd has no EnvironmentFile at all, and cron would hit the same trap, so
# both go through here; only the systemd unit reads the file natively.
RUNNER="$DEST/run.sh"
cat > "$RUNNER" <<RUNNER_EOF
#!/bin/sh
set -a
. "$ENV_FILE"
set +a
exec "$(command -v node)" "$DEST/pull.js" "\$@"
RUNNER_EOF
chmod 700 "$RUNNER"

# --- fetch once now ----------------------------------------------------------
echo "fetching a credential..."
CODEX_CRED_ENDPOINT="$ENDPOINT" CODEX_CRED_TOKEN="$TOKEN" CODEX_CRED_CERT_PIN="$CERT_PIN" \
  node "$DEST/pull.js" --force

# --- register the timer ------------------------------------------------------
if [ "$PLATFORM" = linux ]; then
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  sed -e "s|AGENT_PATH|$DEST/pull.js|g" -e "s|NODE_PATH|$(command -v node)|g" \
    "$SRC_DIR/install/systemd/codex-credential.service" > "$UNIT_DIR/codex-credential.service"
  cp "$SRC_DIR/install/systemd/codex-credential.timer" "$UNIT_DIR/"
  # Containers, WSL and minimal images often have no systemd user session. Keep
  # them unattended with a detached per-user loop for the life of the container.
  if systemctl --user daemon-reload 2>/dev/null &&
     systemctl --user enable --now codex-credential.timer 2>/dev/null; then
    echo "registered systemd user timer:"
    systemctl --user list-timers codex-credential.timer --no-pager 2>/dev/null | sed -n 2p
    # Without lingering the timer stops when the last session ends, which on a
    # server means it silently never runs again.
    if command -v loginctl >/dev/null && [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
      echo "NOTE: user lingering is off, so the timer only runs while you are logged in."
      echo "      For an always-on host: sudo loginctl enable-linger $USER"
    fi
  else
    echo "no systemd user session; installing the container refresh loop"
    "$DEST/install/start-container-loop.sh"
  fi
else
  PLIST="$HOME/Library/LaunchAgents/com.claude-codex-gateway.codex-credential.plist"
  mkdir -p "$(dirname "$PLIST")" "$HOME/Library/Logs"
  sed -e "s|RUNNER_PATH|$RUNNER|g" \
      -e "s|LOG_PATH|$HOME/Library/Logs/codex-credential.log|g" \
    "$SRC_DIR/install/launchd/com.claude-codex-gateway.codex-credential.plist" > "$PLIST"
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load -w "$PLIST"
  echo "registered launchd agent: $PLIST"
  echo "log: $HOME/Library/Logs/codex-credential.log"
fi

cat <<EOF

Done. Verify with:

  $DEST/install/diagnose.sh --endpoint $ENDPOINT

Do NOT verify with 'codex login status'. It reports "Logged in using ChatGPT"
for a garbage token, because it only parses the file.

If codex reports an error naming a host other than chatgpt.com, a third-party
relay is intercepting it — run ./diagnose.sh
EOF
