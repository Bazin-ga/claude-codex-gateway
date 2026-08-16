# client-agent

Runs on **every machine that uses Codex**. Enrols once, then pulls a fresh credential before
expiry and installs it.

## Two steps: enrol, then pull

`enroll.js` exchanges the **shared** enrollment key for a bearer token belonging to **this
machine**, and writes it to `~/.config/codex-credential.env` (mode 600) where `pull.js` and
the timer read it. Run it once, before the first pull:

```bash
export CODEX_CRED_ENDPOINT=https://HOST:8443
export CODEX_CRED_CERT_PIN=<sha256 of the server certificate>
export CODEX_CRED_ENROLLMENT_KEY=<shared key>

node enroll.js                     # machine name defaults to the hostname; CODEX_CRED_NAME overrides
```

Why exchange at all, rather than sharing one bearer everywhere: the minted token is
per-machine and individually revocable, every enrollment is logged server-side, and the
shared key can only *mint* — it cannot read a credential. Re-running mints a fresh token and
revokes this machine's previous one, so installers are safe to re-run and a token that leaked
from this machine dies at its next enrollment.

Machines provisioned by hand with `add-client.js` skip this step and set
`CODEX_CRED_TOKEN` directly.

Platforms: macOS, Windows, Linux — all supported by codex (`darwin-x64`, `darwin-arm64`, `win32-x64`, `win32-arm64`, `linux-x64`, `linux-arm64`).

## What it does

1. Wake on a timer. The shipped units run twice daily; `pull.js` then does nothing unless fewer than `CODEX_CRED_RENEW_BELOW_DAYS` (default 4) remain of a ~10-day token. Many chances to succeed before anything breaks.
2. `GET /credential` from the dispenser with this machine's bearer token.
3. Write `~/.codex/auth.json` (`%USERPROFILE%\.codex\auth.json` on Windows), mode `0600`.
4. Exit. Idempotent — safe to run when the credential is still fresh.

## The credential shape it writes

```jsonc
{
  "auth_mode": "chatgpt",
  "OPENAI_API_KEY": null,
  "tokens": {
    "access_token":  "<from the dispenser>",
    "id_token":      "<from the dispenser>",
    "account_id":    "<from the dispenser>",
    "refresh_token": ""          // ← MUST be present, MUST be invalid
  },
  "last_refresh": "<ISO8601>"
}
```

**`refresh_token` must be present but invalid.** Both halves are load-bearing and both were measured:

- **Present** — deleting the field makes codex fail to parse: `Error checking login status: missing field 'refresh_token'`.
- **Invalid** — this is what makes the client structurally unable to refresh, so it can never rotate the center's token away. Verified: a full codex session left `auth.json` byte-identical.

Either `""` or a same-length placeholder is accepted by codex. Empty string is preferred: it is semantically honest, and a placeholder would emit a doomed refresh request.

## Write it directly — do not use `codex login --with-access-token`

That flag expects an **agent-identity JWT**, not a subscription access token; feeding it one yields `agent identity JWT payload is not valid JSON`. Direct file write is the supported path here.

## Health check: NOT `codex login status`

`codex login status` reports `Logged in using ChatGPT` **even for a garbage token** — it parses the file, it does not validate the credential. Using it as a health check means a dead credential reports healthy right up until a worker dies mid-turn.

Use instead:
- decode the `access_token` `exp` claim and compare against now, or
- make a real call and check the status.

Observable failure signal when a credential is dead: **HTTP 451** with body `{"message":"no_biscuit_no_service"}`.

## Fail closed

If the pull fails, **surface it**. Do not silently leave a stale credential in place — the failure mode is a Codex worker that starts normally and then dies mid-turn on an opaque error, which is exactly the kind of fault that costs hours to trace.

Overwriting is safe: a failed credential does not corrupt or lock the file (verified — after a 451 failure, `auth.json` was unchanged).

## Egress requirement

The machine needs its own route to `chatgpt.com/backend-api/` — **not** `api.openai.com` (a subscription token has no API-platform scope). On a network that blocks it, no credential will help.

A consumer VPN suffices, but most default to **system-proxy** mode, which CLI programs frequently ignore. Classic symptom: the browser reaches ChatGPT while `codex` in a terminal fails, and the credential gets blamed. Fix by switching the VPN to TUN/global mode, or setting `HTTPS_PROXY` explicitly for codex.

Self-check, **in a terminal, not a browser**:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://chatgpt.com/backend-api/codex/responses
# 405 — a GET on a POST-only route — means the path is reachable
# 000 means it is not
```

## Usage

```bash
export CODEX_CRED_ENDPOINT=https://HOST:8443
export CODEX_CRED_TOKEN=<from add-client.js>
export CODEX_CRED_CERT_PIN=<from gen-cert.sh>

node pull.js            # no-op while the local credential is still fresh
node pull.js --force    # renew regardless
```

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_CRED_ENDPOINT` | *required* | Dispenser base URL |
| `CODEX_CRED_TOKEN` | *required* | This machine's bearer token |
| `CODEX_CRED_CERT_PIN` | *required* | SHA-256 of the server certificate |
| `CODEX_CRED_RENEW_BELOW_DAYS` | `4` | Renew once fewer than this many days remain |
| `CODEX_HOME` | `~/.codex` | Where `auth.json` is written |

Installers for all three platforms live in [`install/`](install/) — one command
each, covering prerequisite checks, credential fetch, and timer registration.
Zero dependencies — and Node is already present on any machine that has codex,
since codex ships via npm.

If you also run [`../../credential-console/`](../../credential-console/), it can generate a
self-contained copy of the appropriate installer with the client-agent files, the dispenser
endpoint, the certificate pin, and a one-time per-device token already embedded. The resulting
script runs on a machine that has no access to the console itself.

## Status

Verified end to end against a real codex: the file this agent writes is accepted and drives a
real turn, and a full session leaves it byte-identical.

`test/pull.test.js` and `test/enroll.test.js` cover the parts that decide whether a secret
leaves the machine: a wrong certificate pin sends no HTTP request at all — no bearer, no
enrollment key; a matching pin sends the bearer; enrollment posts the machine name and returns
the minted token; a `403` is reported as an operator problem rather than a machine one; a
success-shaped response with no token is rejected; machine names are sanitised to the pattern
the server accepts; the env file is merged without clobbering unrelated settings; and on
Windows the ACL hardening applies a protected single-identity rule via a non-interactive
encoded command.
