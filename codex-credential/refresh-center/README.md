# refresh-center

The **only** holder of a working `refresh_token`. Keeps a fresh `access_token` available for the dispenser.

Deploy target: an egress-capable host that can reach `auth.openai.com` directly. Confirm that before choosing the host; some networks block it outright.

## Responsibilities

1. Store the real credential (`auth.json`, mode `0600`, in a directory no other service can read).
2. On a schedule comfortably inside the ~10-day access-token lifetime (e.g. daily), exchange the `refresh_token` for a fresh token pair.
3. **Persist the rotated `refresh_token` atomically** — write to a temp file, `fsync`, `rename`. Keep the previous copy as a backup.
4. Expose the current `access_token` + its expiry to the dispenser (shared file, socket, or in-process — an implementation choice; the dispenser must never see the `refresh_token`).
5. **Alert loudly on refresh failure.**

## Why the atomic write matters more than usual

The `refresh_token` rotates single-use. If a refresh succeeds upstream but the new token fails to reach disk, the old one is already dead and the new one is lost — **the credential is unrecoverable and a human must log in again**. This file is the single point of unrecoverability in the whole system; treat every write to it as such.

## Why alerting is not optional

A broken refresh chain is invisible. Clients keep working on their current 10-day tokens and only start failing when those expire, days later, all at once. By then the cause is far behind. Refresh failure must page, not log.

## Refresh call

```
POST https://auth.openai.com/oauth/token
Content-Type: application/json

{"grant_type": "refresh_token", "refresh_token": "<current>", ...}
```

Use it to check reachability before committing to a host: a deliberately invalid refresh token returns **401**, which means the endpoint is reachable and evaluating requests. A `403`, or no response, means this host cannot serve as the center.

## Notes

- **codex CLI is not required here.** The center only issues an HTTP request, so a small VM that could not run the CLI is still a perfectly adequate center.
- Never expose this component's storage path to the dispenser process.
- Back up the credential before any operation that could touch it. In particular, **never run `codex login` on this host** — it wipes the existing credential before waiting for authorization, and a killed login destroys it.

## Usage

```bash
export CODEX_CRED_HOME=/var/lib/codex-credential

node seed.js /path/to/auth.json     # once, from a human `codex login`
node refresh.js                     # per run; install/ has a systemd timer
```

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_CRED_HOME` | `/var/lib/codex-credential` | Data directory |
| `CODEX_CRED_REFRESH_THRESHOLD_DAYS` | `3` | Refresh once fewer than this many days remain |
| `CODEX_CRED_REFRESH_EXPECTED_INTERVAL_SECONDS` | `86400` | Expected cycle interval recorded in the public health snapshot (positive safe integer, max 30 days) |
| `CODEX_CRED_ALERT_WEBHOOK` | — | POST target for alerts; stderr is always used |

Zero dependencies — Node ≥ 20 built-ins only.

Each refresh cycle also publishes `public/health.json` atomically with mode
`0640`. It contains versioned, non-secret cycle timestamps, the last outcome,
failure count, quarantine state, and access-token presence/expiry metadata. The
file never contains a token, fingerprint, account ID, provider error, or path.
Health publication is best effort and cannot change the credential refresh
result. The health snapshot uses `fresh`, `refreshed`, `recovered`,
`quarantined`, `pre_mint_rejected`, `timeout`, `persist_failed`,
`publish_failed`, `unreadable`, `unhandled`, and `operation_blocked` outcomes.

## Status

The live OAuth exchange is only exercised the first time a real credential nears
expiry — performing it consumes the current refresh token, so it cannot be
rehearsed. Everything around it is covered by `test/safety.test.js`: the
quarantine marker is exclusive, durable and clearable; only explicit pre-mint
OAuth rejections clear it; seed and refresh cannot overlap; the operation lock
survives a PID reused across a reboot; a stalled response body still hits the
deadline; a non-2xx alert webhook is reported as a delivery failure; and the
published credential is group-readable and never includes a refresh token.
