# codex-credential

Give **every machine** a working Codex from **one human login, ever** — without the copies invalidating each other.

## The problem

A Codex subscription credential (`~/.codex/auth.json`) carries a `refresh_token` that OpenAI **rotates single-use**: the instant one machine refreshes, every other copy of that token dies permanently — silently, with no diagnostic signal.

So the obvious approach — copy one `auth.json` everywhere — self-destructs within ~10 days. The seed itself also goes stale, so freshly-provisioned machines receive a dead credential too.

## The mechanism

Exactly **one** place holds a working `refresh_token`. Every other machine receives a credential that is **structurally incapable of refreshing**, so it can never rotate the center's token away.

```
┌─ refresh-center ──────────────┐   the ONLY holder of a working refresh_token
│  periodically exchanges it    │   → POST auth.openai.com/oauth/token
│  for a fresh access_token     │   → persists the ROTATED refresh_token atomically
└──────────────┬────────────────┘
               │
┌──────────────▼────────────────┐   authenticated HTTPS endpoint
│  token-dispenser              │   POST /enroll      → mints a machine token, nothing else
│  serves access_token ONLY     │   GET  /credential  → structurally cannot return a refresh_token
└──────────────┬────────────────┘
               │  pull before expiry
┌──────────────▼────────────────┐
│  client-agent (every machine) │   writes ~/.codex/auth.json with the
│                               │   refresh_token set to an INVALID value
└───────────────────────────────┘
```

A client's credential works normally, and any refresh it attempts must fail. No mutual eviction is possible by construction.

## Self-service enrollment

Minting one token per machine by hand makes whoever holds the server a bottleneck for
everyone's setup. `POST /enroll` removes that: a machine presents a **shared enrollment key**
and receives **its own** bearer token.

The shared key is deliberately low-privilege, so it can be distributed the way a
configuration value is rather than the way a credential is:

- it **mints a machine token and nothing else** — the enrollment handler never opens the
  published credential, so no path through it returns one. Structural, like this process's
  inability to leak a refresh token; not a filter that could later regress.
- every token it mints is per-machine, individually revocable, and logged with a name and an
  IP. A leak is bounded and visible.
- rotating it leaves already-enrolled machines untouched — it only stops *new* enrollments
  with the old key.
- re-enrolling a name revokes that name's previous token, so re-running an installer is safe
  and a token that leaked from a machine dies at its next enrollment.

Enrollment is **off until configured**, and an unconfigured server answers exactly like a
wrong key (`403`), so probing cannot distinguish the two.

```bash
node token-dispenser/set-enrollment-key.js --generate   # mint + enable; printed once
node token-dispenser/set-enrollment-key.js --status     # configured? disabled? rotated when?
node token-dispenser/set-enrollment-key.js --disable    # refuse all enrollment
```

Hand-minting with `add-client.js` still works and is unchanged; it is the right tool when a
machine should be provisioned individually rather than self-serve.

## Verified facts (codex-cli 0.145.0, measured 2026-07)

These are measurements, not assumptions. They constrain the implementation.

| Fact | Evidence | Consequence |
|---|---|---|
| `refresh_token` rotates single-use | Binary embeds `refresh token was already used. Please log out and sign in again.` | The whole reason this project exists |
| `access_token` lifetime is exactly **10.0 days** | Decoded `exp - iat` on a real credential | Sets the refresh cadence and the client pull interval |
| `id_token` lives ~1 hour; expiring is harmless | Decoded; API calls authenticate with the access token | Do not treat an expired `id_token` as a fault |
| `refresh_token` is a **mandatory parse field** | Deleting it → `Error checking login status: missing field 'refresh_token'` | Distribute an **invalid value**, never an absent field |
| An invalid `refresh_token` still yields `Logged in` | `""` and a same-length placeholder both accepted | The shape the dispenser emits |
| Such a credential **drives a real turn** | `POST chatgpt.com/backend-api/codex/responses` → 200, model replied | The design works end to end |
| Such a credential **never rotates anything** | `auth.json` byte-identical after a full session | The no-eviction guarantee, empirically |
| Concurrent use of one access token is fine | 3 parallel calls → 3× 200 | Caveat: same host, same IP — this does **not** probe vendor-side sharing detection |
| On failure it **fails cleanly and does not corrupt the file** | Expired/invalid token → HTTP 451 `no_biscuit_no_service`; `auth.json` unchanged | Clients may safely overwrite; failures are diagnosable |
| **`codex login status` lies** | Reports `Logged in` even for a garbage token | **Never use it as a health check** — check `exp`, or make a real call |
| The subscription endpoint is `chatgpt.com/backend-api/codex/responses` | Observed in codex traffic and verified directly | **Not** `api.openai.com` — a subscription token has no API-platform scope (`Missing scopes: api.responses.write`) |
| `codex login` is **destructive** | It wipes the existing credential *before* waiting for authorization | A killed/timed-out login destroys the credential irrecoverably. Back up first; probe only under an isolated `CODEX_HOME` |

## Hard constraints for implementers

1. **The center's `refresh_token` file is the single point of unrecoverability.** Losing or corrupting it means asking a human to log in again. Write atomically (temp + `rename`), keep the previous copy, restrict to `0600`.
2. **Refresh failure must alert loudly.** A dead refresh chain is invisible until every machine expires ~10 days later. Log-and-continue is not acceptable here.
3. **The dispenser must be incapable of leaking a `refresh_token`** — do not read that field at all, rather than filtering it on the way out.
4. **Clients fail closed.** If a pull fails, surface it. Never silently keep serving an expired credential and let a worker die mid-turn on an opaque 451.
5. **Egress is required in two distinct places** — the center needs `auth.openai.com`, clients need `chatgpt.com/backend-api/`. A network that blocks one usually blocks both; check each hop separately rather than assuming.

## Components

| Directory | Role |
|---|---|
| [`refresh-center/`](refresh-center/) | Holds the real `refresh_token`; keeps a fresh `access_token` |
| [`token-dispenser/`](token-dispenser/) | Serves short-lived credentials to authenticated machines; mints machine tokens via `/enroll` |
| [`client-agent/`](client-agent/) | Runs on each machine; enrols once, then pulls and installs before expiry |

[`../credential-console/`](../credential-console/) can import a deployed `codex-credential`
home read-only and, when enrollment is configured, mint per-device tokens and generate
platform-specific agent installers from a web UI.

It can also perform the initial subscription login itself, so the one human login no longer has
to happen through `codex login` on a separate machine with the resulting `auth.json` carried
over by hand. The console either hands the finished credential to the operator for
`refresh-center/seed.js`, or — with `CREDENTIAL_CONSOLE_CODEX_SEED_HOME` set, which trades the
read-only import boundary for write access to `secret/` — seeds this home directly through the
same store and operation lock `seed.js` uses.

## Deploying

See [`DEPLOY.md`](DEPLOY.md). In short: two services on one egress-capable server, one agent on every machine that runs Codex, and exactly one human login at the start — performed either with `codex login` elsewhere or from the credential console.

## Status

The design has been exercised end to end, including the decisive property: the distributed
credential shape runs a real turn while leaving `auth.json` byte-identical.

**Seeds are not backups.** After your center performs its first rotation, the `auth.json` you
seeded it from is permanently dead — OpenAI's refresh tokens are single-use. From that point
the only live copy of the credential is the one under `$CODEX_CRED_HOME/secret/`; that is what
a backup has to cover.

Self-service enrollment is covered by tests in `token-dispenser/test/` — that a minted token
authenticates, that re-enrolling revokes the previous one, that concurrent enrollments do not
lose each other, and that the enrollment path cannot return a credential.

Not verifiable from here: whether many machines sharing one subscription draws vendor
attention. Concurrent calls on one access token succeeded in testing, but from a single host
and IP, which does not probe vendor-side sharing detection at all.
