# token-dispenser

Authenticated HTTPS endpoint that serves short-lived credentials to client machines.

Deployed alongside [`../refresh-center/`](../refresh-center/) on the same host.

## Contract

```
GET /credential
Authorization: Bearer <per-machine token>

200 → {"access_token", "id_token", "account_id", "expires_at"}
401 → unauthenticated, or a revoked token
503 → the source credential is missing, malformed, or already expired
```

```
POST /enroll
{"name": "<machine>", "enrollment_key": "<shared key>"}

200 → {"name", "token"}          the machine's own bearer token, never a credential
403 → wrong key, or enrollment not configured — indistinguishable by design
```

```
GET /health   → 200 {"status": "ok"}   unauthenticated; says the process is up, nothing more
```

Anything else is `404`; a wrong method is `405`; over budget is `429`.

The client turns a `/credential` response into an `auth.json` — see
[`../client-agent/`](../client-agent/) for the exact shape.

## Non-negotiables

1. **Structurally incapable of returning a `refresh_token`.** Do not read that field from the center's storage at all. Filtering it on the way out is one refactor away from a leak; not having it in the process is not.
2. **Per-machine bearer tokens, individually revocable.** One shared secret means one compromise revokes everyone.
3. **Access logging.** Which machine pulled, when. This is the only way a leaked client token becomes visible. Every decision is emitted as one JSON line on stdout.
4. **Rate limiting.** It is a public endpoint. 30 requests per minute per IP overall, and a separate 20 per hour per IP for `/enroll`.

## Blast radius

Bounded by construction: the worst a leaked client bearer token yields is an `access_token` valid for **at most 10 days** that **cannot be renewed**. Compare with distributing the full credential, where a leak grants indefinite account access until someone notices and logs out.

## Exposure

Public HTTPS is the intended deployment: the port is opened in the host's firewall or
security group and clients reach it directly. Putting it behind a private overlay network
instead would work, but it is not required — the blast radius above is what keeps a public
endpoint acceptable, and it removes the overlay as a dependency for every client.

TLS is a self-signed certificate pinned by fingerprint, not a CA chain, because the endpoint
is normally reached by IP and there is no domain for a CA to vouch for. The client verifies
the pin and nothing else; see [`../client-agent/lib/pinned-request.js`](../client-agent/lib/pinned-request.js).

## Usage

```bash
export CODEX_CRED_HOME=/var/lib/codex-credential

./gen-cert.sh <public-ip-or-host>   # prints the pin clients must be given
node add-client.js <machine>        # prints that machine's token, once
node add-client.js --list
node add-client.js --revoke <machine>
node set-enrollment-key.js --generate | --set <key> | --disable | --status
node server.js                      # install/ has a systemd unit
```

| Variable | Default | Purpose |
|---|---|---|
| `CODEX_CRED_HOME` | `/var/lib/codex-credential` | Data directory |
| `CODEX_CRED_PORT` | `8443` | Listen port |
| `CODEX_CRED_BIND` | `0.0.0.0` | Listen address |
| `CODEX_CRED_TLS_CERT` / `_KEY` | `$CODEX_CRED_HOME/tls/server.{crt,key}` | TLS material |

Client tokens are stored as SHA-256 digests and compared in constant time, so a
leaked `clients.json` yields nothing usable. Zero dependencies.

## Status

Covered by `test/server.test.js`: missing, wrong and revoked bearer tokens are refused; an
expired or malformed source credential returns 503 rather than a dead token; the response
carries only the public subset; enrollment is refused when unconfigured, disabled, or given a
wrong key; a minted token then authenticates and the enrollment response never contains a
credential; re-enrolling a name revokes that name's previous token; machine names and the
HTTP method are validated; and concurrent enrollments all persist rather than losing one to a
read-modify-write race.
