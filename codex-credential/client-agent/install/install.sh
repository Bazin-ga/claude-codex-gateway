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

ENDPOINT="" TOKEN="" CERT_PIN="" TOKEN_FILE="" TOKEN_ARG="" PROFILE=""
DEST="${CODEX_CRED_AGENT_DIR:-$HOME/.local/share/claude-codex-gateway/client-agent}"

usage() {
  cat <<'USAGE'
usage: ./install.sh --endpoint <url> --cert-pin <sha256> [--profile <name>] [--token-file <path> | --token <token>]

  --endpoint   dispenser base URL, e.g. https://203.0.113.10:8443
  --token-file mode-600 regular file containing this machine's bearer token
  --token      legacy bearer-token argument (prefer --token-file or CODEX_CRED_TOKEN)
  --cert-pin   SHA-256 of the dispenser's certificate (from gen-cert.sh)
  --profile    install an isolated Codex profile (does not modify ~/.codex)
  --dir        where to install the agent (default ~/.local/share/claude-codex-gateway/client-agent)

  If --token-file and --token are omitted, CODEX_CRED_TOKEN is read from this
  process environment. The token is never printed or placed in a unit/plist.
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --endpoint)   ENDPOINT="${2:?--endpoint needs a value}"; shift 2 ;;
    --token-file) TOKEN_FILE="${2:?--token-file needs a value}"; shift 2 ;;
    --token)      TOKEN_ARG="${2:?--token needs a value}"; shift 2 ;;
    --cert-pin) CERT_PIN="${2:?--cert-pin needs a value}"; shift 2 ;;
    --profile)  PROFILE="${2:?--profile needs a value}"; shift 2 ;;
    --dir)      DEST="${2:?--dir needs a value}"; shift 2 ;;
    -h|--help)  usage; exit 0 ;;
    *) echo "unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

missing=()
[ -n "$ENDPOINT" ] || missing+=(--endpoint)
[ -n "$CERT_PIN" ] || missing+=(--cert-pin)
if [ ${#missing[@]} -gt 0 ]; then
  echo "missing required argument(s): ${missing[*]}" >&2
  usage >&2
  exit 2
fi

fail_input() {
  echo "invalid credential input: $1" >&2
  exit 2
}

# Dispenser bearer tokens are base64url values. Keeping the accepted alphabet
# deliberately narrow also makes the mode-600 env file safe to source: a token
# can never turn into a second shell command or an injected environment line.
validate_token() {
  local value="$1"
  [ -n "$value" ] || fail_input 'token is empty'
  [[ "$value" =~ ^[A-Za-z0-9_-]+$ ]] || fail_input 'token must be a single base64url-safe line'
}

read_token_file() {
  local path="$1" mode last_byte value
  [[ -n "$path" ]] || fail_input 'token file path is empty'
  [[ "$path" != -* ]] || fail_input 'token file path must not start with a dash'
  [[ ! -L "$path" ]] || fail_input 'token file must not be a symlink'
  [[ -f "$path" ]] || fail_input 'token file must be a regular file'
  mode="$(stat -c '%a' -- "$path" 2>/dev/null || stat -f '%Lp' "$path" 2>/dev/null || true)"
  [[ "$mode" == '600' ]] || fail_input 'token file must have mode 600'
  # Command substitution strips trailing newlines, so inspect the raw last byte
  # before reading. A CR/LF is never a valid token-file terminator.
  last_byte="$(tail -c 1 "$path" 2>/dev/null | od -An -t x1 | tr -d '[:space:]')"
  [[ "$last_byte" != '0a' && "$last_byte" != '0d' ]] || fail_input 'token file must not contain a newline'
  # Catch embedded NUL/control bytes before Bash command substitution can drop
  # them while reading the file into a variable.
  if LC_ALL=C grep -a -q '[^A-Za-z0-9_-]' "$path" 2>/dev/null; then
    fail_input 'token file contains unsupported characters'
  fi
  value="$(<"$path")" || fail_input 'token file could not be read'
  validate_token "$value"
  printf '%s' "$value"
}

if [[ -n "$TOKEN_FILE" && -n "$TOKEN_ARG" ]]; then
  fail_input 'choose --token-file or legacy --token, not both'
fi
if [[ -n "$TOKEN_FILE" ]]; then
  TOKEN="$(read_token_file "$TOKEN_FILE")"
elif [[ -n "$TOKEN_ARG" ]]; then
  TOKEN="$TOKEN_ARG"
elif [[ -n "${CODEX_CRED_TOKEN:-}" ]]; then
  TOKEN="$CODEX_CRED_TOKEN"
else
  fail_input 'provide --token-file, CODEX_CRED_TOKEN, or legacy --token'
fi
validate_token "$TOKEN"

if [[ -n "$PROFILE" && ! "$PROFILE" =~ ^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$ ]]; then
  fail_input 'profile must match [A-Za-z0-9][A-Za-z0-9._-]{0,63}'
fi

# These values are later written to a sourced env file. Reject control lines so
# an accidental paste cannot turn the generated runner into shell code.
[[ "$ENDPOINT" != *$'\n'* && "$ENDPOINT" != *$'\r'* ]] || fail_input 'endpoint must be a single line'
[[ "$CERT_PIN" =~ ^[A-Fa-f0-9]{64}$ ]] || fail_input 'cert pin must be 64 hexadecimal characters'
ENDPOINT="$(node -e '
const url = new URL(process.argv[1]);
if (url.protocol !== "https:" || !url.hostname || url.username || url.password
  || url.search || url.hash || !["", "/"].includes(url.pathname)) process.exit(2);
process.stdout.write(url.origin);
' "$ENDPOINT")" || fail_input 'endpoint must be an HTTPS origin without credentials, path, query, or fragment'

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
  cp "$SRC_DIR/pull.js" "$SRC_DIR/profiles.js" "$SRC_DIR/codex-gateway.js" "$SRC_DIR/package.json" "$DEST/"
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
PROFILE_ROOT="$HOME/.local/share/claude-codex-gateway/codex-profiles"
if [[ -n "$PROFILE" ]]; then
  ENV_FILE=""
else
  ENV_FILE="$HOME/.config/codex-credential.env"
  CODEX_CRED_ENV_TARGET="$ENV_FILE" CODEX_CRED_ENDPOINT="$ENDPOINT" \
    CODEX_CRED_TOKEN="$TOKEN" CODEX_CRED_CERT_PIN="$CERT_PIN" \
    node --input-type=module <<'NODE_WRITE_ENV'
import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
const target = process.env.CODEX_CRED_ENV_TARGET;
const parent = dirname(target);
await mkdir(parent, { recursive: true, mode: 0o700 });
await chmod(parent, 0o700);
try {
  const current = await lstat(target);
  if (current.isSymbolicLink() || !current.isFile() || current.nlink !== 1) {
    throw new Error('credential env target is unsafe');
  }
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
const tmp = target + '.' + randomBytes(6).toString('hex') + '.tmp';
let handle;
let moved = false;
let writtenStat = null;
try {
  handle = await open(tmp, 'wx', 0o600);
  const data = 'CODEX_CRED_ENDPOINT=' + process.env.CODEX_CRED_ENDPOINT + '\n'
    + 'CODEX_CRED_TOKEN=' + process.env.CODEX_CRED_TOKEN + '\n'
    + 'CODEX_CRED_CERT_PIN=' + process.env.CODEX_CRED_CERT_PIN + '\n';
  await handle.writeFile(data);
  await handle.sync();
  writtenStat = await handle.stat();
  await handle.close();
  handle = null;
  await rename(tmp, target);
  moved = true;
  const committed = await lstat(target);
  if (committed.isSymbolicLink() || !committed.isFile() || committed.nlink !== 1
    || !writtenStat || committed.dev !== writtenStat.dev || committed.ino !== writtenStat.ino) {
    throw new Error('credential env target changed during atomic commit');
  }
  if (process.platform !== 'win32') {
    const directory = await open(parent, 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  }
} finally {
  if (handle) await handle.close().catch(() => {});
  if (!moved) await unlink(tmp).catch(() => {});
}
NODE_WRITE_ENV
  echo "wrote $ENV_FILE (mode 600)"
fi

# A wrapper that EXPORTS the env file. Sourcing alone would only set shell
# variables, which a child node process never sees — the bug this avoids.
# launchd has no EnvironmentFile at all, and cron would hit the same trap, so
# both go through here; only the systemd unit reads the file natively.
if [[ -n "$PROFILE" ]]; then
  RUNNER="$DEST/run-profiles.sh"
  cat > "$RUNNER" <<RUNNER_EOF
#!/bin/sh
export CODEX_CRED_PROFILE_ROOT='$PROFILE_ROOT'
unset CODEX_HOME
exec "$(command -v node)" "$DEST/pull.js" --all-profiles "\$@"
RUNNER_EOF
else
  RUNNER="$DEST/run.sh"
  cat > "$RUNNER" <<RUNNER_EOF
#!/bin/sh
set -a
. "$ENV_FILE"
set +a
exec "$(command -v node)" "$DEST/pull.js" "\$@"
RUNNER_EOF
fi
chmod 700 "$RUNNER"

# --- fetch once now ----------------------------------------------------------
echo "fetching a credential..."
if [[ -n "$PROFILE" ]]; then
  CODEX_CRED_PROFILE_ROOT="$PROFILE_ROOT" CODEX_CRED_ENDPOINT="$ENDPOINT" \
    CODEX_CRED_TOKEN="$TOKEN" CODEX_CRED_CERT_PIN="$CERT_PIN" \
    node "$DEST/profiles.js" install --name "$PROFILE"
  BIN_DIR="$HOME/.local/bin"
  mkdir -p "$BIN_DIR"
  cat > "$BIN_DIR/codex-gateway" <<LAUNCHER_EOF
#!/bin/sh
export CODEX_CRED_PROFILE_ROOT='$PROFILE_ROOT'
exec "$(command -v node)" "$DEST/codex-gateway.js" "\$@"
LAUNCHER_EOF
  cat > "$BIN_DIR/codex-profile-$PROFILE" <<PROFILE_LAUNCHER_EOF
#!/bin/sh
export CODEX_HOME='$PROFILE_ROOT/$PROFILE/codex-home'
unset CODEX_CRED_TOKEN CODEX_CRED_ENDPOINT CODEX_CRED_CERT_PIN CODEX_CRED_ENROLLMENT_KEY CODEX_CRED_PROFILE_ROOT
exec codex "\$@"
PROFILE_LAUNCHER_EOF
  chmod 700 "$BIN_DIR/codex-gateway" "$BIN_DIR/codex-profile-$PROFILE"
else
  CODEX_CRED_ENDPOINT="$ENDPOINT" CODEX_CRED_TOKEN="$TOKEN" CODEX_CRED_CERT_PIN="$CERT_PIN" \
    node "$DEST/pull.js" --force
fi

# --- register the timer ------------------------------------------------------
if [ "$PLATFORM" = linux ]; then
  UNIT_DIR="$HOME/.config/systemd/user"
  mkdir -p "$UNIT_DIR"
  if [[ -n "$PROFILE" ]]; then
    TIMER_NAME="codex-credential-profiles.timer"
    sed -e "s|RUNNER_PATH|$RUNNER|g" \
      "$SRC_DIR/install/systemd/codex-credential-profiles.service" \
      > "$UNIT_DIR/codex-credential-profiles.service"
    cp "$SRC_DIR/install/systemd/codex-credential-profiles.timer" "$UNIT_DIR/"
  else
    TIMER_NAME="codex-credential.timer"
    sed -e "s|AGENT_PATH|$DEST/pull.js|g" -e "s|NODE_PATH|$(command -v node)|g" \
      "$SRC_DIR/install/systemd/codex-credential.service" > "$UNIT_DIR/codex-credential.service"
    cp "$SRC_DIR/install/systemd/codex-credential.timer" "$UNIT_DIR/"
  fi
  # Containers, WSL and minimal images often have no systemd user session. Keep
  # them unattended with a detached per-user loop for the life of the container.
  if systemctl --user daemon-reload 2>/dev/null &&
     systemctl --user enable --now "$TIMER_NAME" 2>/dev/null; then
    echo "registered systemd user timer:"
    systemctl --user list-timers "$TIMER_NAME" --no-pager 2>/dev/null | sed -n 2p
    # Without lingering the timer stops when the last session ends, which on a
    # server means it silently never runs again.
    if command -v loginctl >/dev/null && [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
      echo "NOTE: user lingering is off, so the timer only runs while you are logged in."
      echo "      For an always-on host: sudo loginctl enable-linger $USER"
    fi
  else
    echo "no systemd user session; installing the container refresh loop"
    if [[ -n "$PROFILE" ]]; then
      CODEX_CRED_RUNNER="$RUNNER" CODEX_CRED_LOOP_NAME=codex-credential-profiles \
        CODEX_CRED_LOOP_FORCE=0 \
        "$DEST/install/start-container-loop.sh"
    else
      "$DEST/install/start-container-loop.sh"
    fi
  fi
else
  if [[ -n "$PROFILE" ]]; then
    PLIST_NAME="com.claude-codex-gateway.codex-credential-profiles.plist"
    PLIST_TEMPLATE="$SRC_DIR/install/launchd/$PLIST_NAME"
    LOG_NAME="codex-credential-profiles.log"
  else
    PLIST_NAME="com.claude-codex-gateway.codex-credential.plist"
    PLIST_TEMPLATE="$SRC_DIR/install/launchd/$PLIST_NAME"
    LOG_NAME="codex-credential.log"
  fi
  PLIST="$HOME/Library/LaunchAgents/$PLIST_NAME"
  mkdir -p "$(dirname "$PLIST")" "$HOME/Library/Logs"
  sed -e "s|RUNNER_PATH|$RUNNER|g" \
      -e "s|LOG_PATH|$HOME/Library/Logs/$LOG_NAME|g" \
    "$PLIST_TEMPLATE" > "$PLIST"
  launchctl unload "$PLIST" 2>/dev/null || true
  launchctl load -w "$PLIST"
  echo "registered launchd agent: $PLIST"
  echo "log: $HOME/Library/Logs/$LOG_NAME"
fi

if [[ -n "$PROFILE" ]]; then
  VERIFY_COMMAND="node $DEST/profiles.js status"
else
  VERIFY_COMMAND="$DEST/install/diagnose.sh --endpoint $ENDPOINT"
fi

cat <<EOF

Done. Verify with:

  $VERIFY_COMMAND

${PROFILE:+Selected profile: $PROFILE. Start new sessions with codex-gateway or codex-profile-$PROFILE.}

Do NOT verify with 'codex login status'. It reports "Logged in using ChatGPT"
for a garbage token, because it only parses the file.

If codex reports an error naming a host other than chatgpt.com, a third-party
relay is intercepting it — run ./diagnose.sh
EOF
