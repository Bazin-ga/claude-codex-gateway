#!/usr/bin/env bash
set -euo pipefail

# Installer input contract / secret-output regression test.
# The fake node records argv only to a private test file and checks that the
# marker arrives via the child environment, never as an argument or output.

ROOT=$(CDPATH='' cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd -P)
TEST_ROOT=$(mktemp -d "${TMPDIR:-/tmp}/codex-client-input-test.XXXXXX")
FAKE_BIN="$TEST_ROOT/bin"
MARKER='INSTALL_TOKEN_MARKER_9f4c2a'
PIN=$(printf 'a%.0s' {1..64})
TOKEN_FILE="$TEST_ROOT/token"

cleanup() {
  rm -rf -- "$TEST_ROOT"
}
trap cleanup EXIT

mkdir -p "$FAKE_BIN"
printf '%s' "$MARKER" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"

cat > "$FAKE_BIN/node" <<'FAKE_NODE'
#!/usr/bin/env bash
set -euo pipefail
if [[ ${1:-} == -v || ${1:-} == --version ]]; then
  printf '%s\n' 'v22.0.0'
  exit 0
fi
if [[ ${1:-} == -e ]]; then
  printf '%s' 'https://127.0.0.1:8443'
  exit 0
fi
if [[ ${1:-} == --input-type=module ]]; then
  mkdir -p "$(dirname "$CODEX_CRED_ENV_TARGET")"
  printf 'CODEX_CRED_ENDPOINT=%s\nCODEX_CRED_TOKEN=%s\nCODEX_CRED_CERT_PIN=%s\n' \
    "$CODEX_CRED_ENDPOINT" "$CODEX_CRED_TOKEN" "$CODEX_CRED_CERT_PIN" \
    > "$CODEX_CRED_ENV_TARGET"
  chmod 600 "$CODEX_CRED_ENV_TARGET"
  exit 0
fi
printf '%s\n' "$*" >> "$ARG_LOG"
if [[ "$*" == *"$TEST_MARKER"* ]]; then
  printf '%s\n' 'marker found in child argv' > "$FAIL_FILE"
  exit 91
fi
[[ ${CODEX_CRED_TOKEN:-} == "$TEST_MARKER" ]] || {
  printf '%s\n' 'child did not receive the expected token environment' > "$FAIL_FILE"
  exit 92
}
mkdir -p "$HOME/.codex"
printf '%s\n' '{"tokens":{"access_token":"test"}}' > "$HOME/.codex/auth.json"
FAKE_NODE

cat > "$FAKE_BIN/codex" <<'FAKE_CODEX'
#!/usr/bin/env bash
printf '%s\n' 'codex-cli test'
FAKE_CODEX

cat > "$FAKE_BIN/systemctl" <<'FAKE_SYSTEMCTL'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$*" == *"$TEST_MARKER"* ]]; then
  printf '%s\n' 'marker found in scheduler argv' > "$FAIL_FILE"
  exit 93
fi
case " $* " in
  *' daemon-reload '*|*' enable --now '*|*' list-timers '*) exit 0 ;;
  *) exit 0 ;;
esac
FAKE_SYSTEMCTL

cat > "$FAKE_BIN/loginctl" <<'FAKE_LOGINCTL'
#!/usr/bin/env bash
exit 1
FAKE_LOGINCTL
chmod +x "$FAKE_BIN/node" "$FAKE_BIN/codex" "$FAKE_BIN/systemctl" "$FAKE_BIN/loginctl"

run_case() {
  local name="$1" source="$2" expected="$3"
  shift 3
  local case_dir="$TEST_ROOT/$name" home_dir="$TEST_ROOT/$name/home" status
  mkdir -p "$case_dir" "$home_dir"
  local -a command=(env -u CODEX_CRED_TOKEN
    "HOME=$home_dir"
    "PATH=$FAKE_BIN:/usr/bin:/bin"
    "TEST_MARKER=$MARKER"
    "ARG_LOG=$case_dir/argv.log"
    "FAIL_FILE=$case_dir/fail.marker")
  if [[ "$source" == env ]]; then
    command+=("CODEX_CRED_TOKEN=$MARKER")
  elif [[ "$source" == newline-env ]]; then
    command+=("CODEX_CRED_TOKEN=${MARKER}"$'\n')
  fi
  set +e
  "${command[@]}" bash "$ROOT/install/install.sh" \
    --endpoint https://127.0.0.1:8443 --cert-pin "$PIN" "$@" \
    > "$case_dir/stdout" 2> "$case_dir/stderr"
  status=$?
  set -e
  [[ "$status" == "$expected" ]] || {
    echo "$name: expected exit $expected, got $status" >&2
    sed -n '1,120p' "$case_dir/stdout" "$case_dir/stderr" >&2 || true
    return 1
  }
  # The marker is allowed only in the protected credential destination. All
  # observable installer output, child argv, scheduler argv, and durable logs
  # must remain marker-free.
  local file
  while IFS= read -r -d '' file; do
    [[ "$file" == "$home_dir/.config/codex-credential.env" ]] && continue
    if grep -Fq -- "$MARKER" "$file"; then
      echo "$name: credential marker leaked into $file" >&2
      return 1
    fi
  done < <(find "$case_dir" "$home_dir" -type f -print0 2>/dev/null)
  if [[ "$expected" == 0 ]]; then
    [[ -f "$home_dir/.config/codex-credential.env" ]] || {
      echo "$name: protected env file was not written" >&2
      return 1
    }
    [[ "$(stat -c %a "$home_dir/.config/codex-credential.env")" == 600 ]] || {
      echo "$name: env file is not mode 600" >&2
      return 1
    }
  fi
}

# New non-argv flow: mode-600 token file.
run_case token_file file 0 --token-file "$TOKEN_FILE"

# Process environment is the second supported non-argv flow.
run_case process_env env 0

# Existing hand-written installs remain compatible, but the token still must
# not reach the child argv or any installer output.
run_case legacy_arg arg 0 --token "$MARKER"

# Unsafe token files are rejected before node/scheduler execution.
chmod 644 "$TOKEN_FILE"
run_case wrong_mode none 2 --token-file "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
rm -f "$TOKEN_FILE"
ln -s "$TEST_ROOT/does-not-exist" "$TOKEN_FILE"
run_case symlink none 2 --token-file "$TOKEN_FILE"
rm -f "$TOKEN_FILE"
: > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
run_case empty_file none 2 --token-file "$TOKEN_FILE"
printf '%s\n' "$MARKER" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
run_case newline_file none 2 --token-file "$TOKEN_FILE"
printf '%s' "${MARKER};unexpected" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
run_case unsafe_chars none 2 --token-file "$TOKEN_FILE"
printf '%s\0x' "$MARKER" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
run_case nul_byte none 2 --token-file "$TOKEN_FILE"
mkdir -p "$TOKEN_FILE.dir"
run_case directory none 2 --token-file "$TOKEN_FILE.dir"
printf '%s' "$MARKER" > "$TOKEN_FILE"
chmod 600 "$TOKEN_FILE"
run_case ambiguous_sources none 2 --token-file "$TOKEN_FILE" --token "$MARKER"

# Unsafe process-environment content is rejected without echoing the value.
run_case newline_env newline-env 2

echo 'client-agent installer input and secret-output tests passed'
