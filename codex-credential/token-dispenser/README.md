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
Authorization: Bearer <shared enrollment key>
{"name": "<machine>",
 "machine_id": "<opaque handle>",            optional
 "previous_token_sha256": "<sha256 hex>"}    optional

200 → {"name", "token"}          the machine's own bearer token, never a credential
400 → the name, the machine_id or the digest is malformed
403 → wrong key, or enrollment not configured — indistinguishable by design
```

`machine_id` is a random handle the agent generated once and kept
([`../client-agent/lib/machine-id.js`](../client-agent/lib/machine-id.js)). It is not derived
from the hostname, the user, a MAC address or a serial number: it identifies a machine
across reinstalls and says nothing else, about the host or about who is running it.

It exists to answer one question the name cannot: is this the same machine re-installing, or
a second machine that happened to pick the same name? Two people who both called their laptop
`laptop` used to kick each other offline on every install, silently, and find out days later
as a 401 mid-turn.

`previous_token_sha256` is the digest of the token the caller currently holds. Only its holder
can produce it, so it is proof rather than inference — and it is what retires a row after the
machine has lost the handle beside it (a rebuilt container, a restored backup, an unwritable
`~/.config`). The server already stores that exact value, so receiving it tells it nothing new,
and a digest cannot be replayed as a bearer.

A re-enrollment revokes, among the active rows:

- the row whose `token_sha256` the caller presented, whatever its name or handle;
- rows of the same name that carry **no** handle. That is precisely what the pre-handle rule
  did with them, so a machine's own pre-upgrade row is retired on its first fingerprinted
  enrollment rather than left live forever, and a caller that reports no handle still cleans
  up after itself. Logged as `reclaimed_legacy`;
- rows of the same name carrying the caller's own handle.

Rows of that name carrying a **different** handle are always left alone, in both directions —
a caller reporting no handle has no more claim on them than one reporting another handle. They
are counted as `kept_same_name` and logged as `enroll_name_shared`, which is the line to grep
for "more than one machine answers to this name".

A machine that loses its handle *and* its token can prove nothing and claim nothing, so its
previous row stays active until it expires with the credential or `add-client.js --revoke`
retires it. Nothing in such a request distinguishes it from a genuinely new machine.

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
credential; a reported machine handle is recorded on the client row; a malformed handle or
digest is refused and an absent one still enrols; re-enrolling revokes the previous token when
the handle matches, reclaims handle-less rows of the same name in both directions, retires a
row proven by `previous_token_sha256` even across a lost handle or a rename, and leaves another
machine's fingerprinted row of the same name working; machine names and the HTTP method are
validated; and concurrent enrollments all persist rather than losing one to a read-modify-write
race.
