# Installing the client agent

One installer per platform. Each does the same four things: check prerequisites,
install the agent, fetch a credential immediately, and register a timer so it
stays fresh unattended.

You need three values, all produced on the dispenser host:

| Value | Where it comes from |
|---|---|
| endpoint | the dispenser's URL, `https://<public-ip-or-host>:8443` |
| token | `node add-client.js <machine-name>` — printed **once** |
| cert pin | `./gen-cert.sh <public-ip-or-host>` — the SHA-256 it prints |

A machine can also mint its own token from the shared enrollment key instead, with
`node enroll.js` — see [`../README.md`](../README.md).

The preferred input is a mode-600 regular token file. Create it without a
trailing newline, and keep it outside shared or synchronized folders:

```bash
umask 077
printf '%s' '<token-from-add-client>' > "$HOME/.config/codex-credential.token"
chmod 600 "$HOME/.config/codex-credential.token"
```

Two things to know before running either installer:

**Do not put the token in a command line.** The new flow reads
`--token-file <mode-600-file>` or the current process's `CODEX_CRED_TOKEN`
environment variable. The token file must be a regular non-symlink file with
exact mode `600`, contain one base64url-safe line, and be non-empty. Invalid
permissions, symlinks, empty files, whitespace, and newlines are rejected. The
legacy `--token` / `-Token` option remains for old hand-written installs, but it
can be exposed through `ps` and shell history and should not be used for new
generated installers. `node enroll.js` remains preferable when available.

**Choose legacy or profile mode deliberately.** Without `--profile`, the legacy
installer still replaces `~/.codex/auth.json` without a backup. With `--profile
<name>`, it writes an isolated Codex home under
`~/.local/share/claude-codex-gateway/codex-profiles/`, leaves `~/.codex`
byte-identical, and installs `codex-gateway` plus `codex-profile-<name>` launchers.
Profile selection affects only newly started Codex processes; an already-running
process keeps the `CODEX_HOME` it started with.

## Linux / macOS

```bash
./install.sh --endpoint https://HOST:8443 \
  --token-file "$HOME/.config/codex-credential.token" \
  --profile codex-team \
  --cert-pin <sha256>
```

Alternatively, keep the token only in the current process environment:

```bash
CODEX_CRED_TOKEN='<token>' ./install.sh \
  --endpoint https://HOST:8443 --cert-pin <sha256>
```

Registers a **systemd user timer** on Linux, a **launchd agent** on macOS, or a
detached 12-hour refresh loop when a container has no systemd user session. Nothing
requires root; everything is scoped to the invoking user.

A systemd user timer only runs while that user has a session. On an always-on host, enable
lingering (`sudo loginctl enable-linger $USER`) or the timer silently stops firing after you
log out. The installer warns when lingering is off.

## Windows

Run from an **already-open PowerShell window** — double-clicking a `.ps1` closes
the window the instant it finishes, so you would never see the result.

```powershell
.\windows\install.ps1 -Endpoint https://HOST:8443 `
  -TokenFile "$env:USERPROFILE\.config\codex-credential.token" `
  -Profile codex-team `
  -CertPin <sha256>
```

Or set `CODEX_CRED_TOKEN` in the current PowerShell process and omit
`-TokenFile`. `-Token` is retained only for compatibility with older installs.

Registers a scheduled task (06:00, 18:00, and at logon).

## Switching profiles

Each profile must come from its own independent credential centre: a separate
`CODEX_CRED_HOME`, refresh process, dispenser, certificate, and device token.
Never seed a second account into the first account's home.

```bash
node ~/.local/share/claude-codex-gateway/client-agent/profiles.js list
node ~/.local/share/claude-codex-gateway/client-agent/profiles.js select codex-team
codex-gateway                 # selected profile
codex-profile-codex-team      # fixed profile, independent of selection
```

`select` first fetches and validates the target credential, including its
id-token account binding, then atomically updates the selected manifest. A
failure leaves the previous selection and every existing profile usable. It
does not retry a request through another account and does not hot-switch a
running Codex process. The unattended timer refreshes every bound profile, not
only the selected one; one failed profile does not prevent the others from being
attempted and selection is never changed by refresh.

## When something is wrong

```bash
./diagnose.sh --endpoint https://HOST:8443      # Linux / macOS
.\windows\diagnose.ps1 -Endpoint https://HOST:8443   # Windows
```

Read-only. It reports which credential is installed and whether it came from this
system, anything configured that would hijack codex's requests, network
reachability, and timer state.

## Two failure modes worth knowing before they bite

**A third-party API relay silently wins.** If `OPENAI_BASE_URL` is set, or
`config.toml` defines `base_url` / `model_provider`, codex talks to that relay and
the credential installed here is never used. The symptom is an error naming a host
that is not `chatgpt.com`. Both installers warn about this; `diagnose` pinpoints
which one is in play. The two paths are mutually exclusive — clear the relay
config to use the subscription.

**A credential is not connectivity.** The agent only supplies credentials; the
machine still needs its own route to `chatgpt.com/backend-api/`. In particular
many VPN clients default to *system proxy* mode, which command-line programs
frequently ignore — the browser reaches ChatGPT while codex does not, and the
credential gets blamed. `diagnose` distinguishes the two: reaching the codex
endpoint returns `405` (a GET on a POST-only route), not `000`.

## Never run `codex login` on a machine using this system

It **wipes the existing credential before** waiting for authorization, so an
interrupted or timed-out login destroys it irrecoverably. A `codex login
--device-auth` that is killed on timeout leaves no working credential behind.
You do not need to log in — that is the entire point of this system.

## Files here

| Path | Purpose |
|---|---|
| `install.sh` / `diagnose.sh` | Linux + macOS |
| `windows/install.ps1` / `windows/diagnose.ps1` | Windows |
| `systemd/` | unit + timer templates, placeholders substituted by `install.sh` |
| `launchd/` | plist template, likewise |

### Two conventions these files follow

**The Windows scripts are ASCII-only.** Windows PowerShell 5.1 decodes a
BOM-less `.ps1` using the system ANSI code page, so non-ASCII characters in such a
file break parsing outright on non-English systems — the window simply flashes and
closes. Keeping them ASCII removes the failure mode rather than working around it.

**Credentials live in a mode-600 env file**, never inline in a unit or plist. The
systemd unit reads it via `EnvironmentFile`; launchd and cron have no equivalent,
so they go through `run.sh`, which **exports** the values — sourcing alone sets
only shell variables, which a child `node` process never sees. The installer
never writes the bearer to stdout/stderr, a scheduled task/unit/plist, or its
durable log.

**The Windows installer does not use `Start-Transcript`.** Its header records the
invoking command line, which would put this machine's bearer token in clear text
into a long-lived file under `%TEMP%` (verified experimentally). It writes its own
log instead, containing only what it is explicitly given — and it is never given a
secret.
