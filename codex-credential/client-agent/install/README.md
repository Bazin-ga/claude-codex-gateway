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

Two things to know before running either installer:

**The token is a command-line argument.** It is therefore readable by any local
user through `ps` while the installer runs, and the invocation is recorded in
shell history. On a shared machine, prefer `node enroll.js`, which is never given
a long-lived token, or remove the history entry afterwards.

**The installer replaces `~/.codex/auth.json`.** It fetches immediately and
without a backup. If this machine has a personal `codex login` you want to keep,
copy that file somewhere safe first, or rehearse against a scratch directory with
`CODEX_HOME=/tmp/codex-probe node pull.js --force`.

## Linux / macOS

```bash
./install.sh --endpoint https://HOST:8443 --token <token> --cert-pin <sha256>
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
.\windows\install.ps1 -Endpoint https://HOST:8443 -Token <token> -CertPin <sha256>
```

Registers a scheduled task (06:00, 18:00, and at logon).

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
only shell variables, which a child `node` process never sees.

**The Windows installer does not use `Start-Transcript`.** Its header records the
invoking command line, which would put this machine's bearer token in clear text
into a long-lived file under `%TEMP%` (verified experimentally). It writes its own
log instead, containing only what it is explicitly given — and it is never given a
secret.
