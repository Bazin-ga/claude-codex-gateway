# credential-console

Multi-account control plane for subscription-backed Codex and Claude Code access.

It solves two related operational problems:

1. provider account owners should authorize an account once, not once per workspace or device;
2. members must not receive a reusable provider OAuth credential.

The console keeps Claude master credentials encrypted at rest, issues one-time enrollment
links, and gives every device an independently revocable token. Claude Code talks to a
restricted gateway that replaces the device token with the selected account's OAuth token.
The provider credential is never rendered after submission and never enters a member device.
The control plane remains tailnet-only while the authenticated Claude gateway can be published
on a separate public origin for devices that do not belong to the tailnet.

Existing `codex-credential` deployments can be imported read-only. The console then shows
their expiry and active-client count without reading the Codex refresh token. When dispenser
enrollment is configured, a tailnet member can also mint a per-device Codex token and download
a platform-specific agent installer without receiving the shared enrollment key.

A Codex account can also be authorized from the console itself, so the ChatGPT subscription
credential no longer has to be produced by a `codex login` on some other machine and carried
over by hand. That import boundary stays read-only unless
`CREDENTIAL_CONSOLE_CODEX_SEED_HOME` is set — see
[Codex account authorization](#codex-account-authorization).

## Status

V1 implements:

- administrator UI authenticated by Tailscale identity, or deliberately open;
- English-by-default UI with a persistent Chinese language switch;
- multiple Claude Code accounts, identified by operator-supplied alias and email label;
- a permanent, tailnet-only owner page for each Claude account that creates short-lived
  Anthropic PKCE authorization sessions and exchanges the returned code on the server;
- AES-256-GCM encryption of Claude OAuth tokens with a separate mode-600 master key;
- one-time, 30-minute device enrollment links;
- tailnet-member self-service issuance for Claude Code devices, with no console sign-in step;
- distinct, revocable device tokens;
- a public-capable streaming Claude gateway limited to `/v1/messages`,
  `/v1/messages/count_tokens`, and `/v1/models`, with failed-authentication, per-device rate,
  and per-device concurrency limits;
- macOS/Linux and Windows profile instructions shown once at enrollment;
- read-only import and expiry/health display for one or more existing
  `codex-credential` homes;
- a permanent authorization page for each Codex account that runs the ChatGPT subscription
  PKCE flow on the server and either seeds a `codex-credential` home directly or shows the
  resulting `auth.json` once for the operator to copy;
- hourly, token-free-at-rest quota snapshots for Claude Code and Codex, showing the five-hour
  and weekly windows whenever the provider reports them;
- tailnet-member Codex self-enrollment with self-contained macOS, Linux, and Windows installers
  that use the public dispenser and do not fetch files from the private console;
- structured metadata-only request logs.

V1 deliberately does **not**:

- display, download, or copy a provider OAuth token after it is stored;
- proxy Claude Desktop, Remote Control, or Claude.ai connectors;
- replace the existing `codex-credential` client-token registry or revocation CLI.

## Account-owner workflow

An administrator first creates a placeholder account with an alias and the account owner's
exact email address. The account receives a permanent, tailnet-only **Owner authorization**
page. That page itself does not expire, so it can be bookmarked or sent to the owner whenever
they are ready.

On the permanent page, the owner:

1. selects **Start fresh authorization**;
2. opens the generated Anthropic authorization link and signs in with the displayed email;
3. copies the returned `code#state` value into the same page within 15 minutes;
4. selects **Complete authorization**.

The server verifies the PKCE state, exchanges the code directly with Anthropic, rejects an
account whose returned email differs from the configured owner email, and stores only the
encrypted one-year token with `user:inference` and read-only `user:profile` scope. Starting
again supersedes every unfinished session for
that account. Neither the account owner nor an administrator handles the resulting provider
token.

The profile scope is used only to read the same five-hour and weekly quota data shown by the
provider CLI. An account whose stored credential lacks that scope keeps working for inference;
the console marks it as needing reauthorization, and its owner completes the permanent
authorization page once to enable quota reporting. Member device tokens and installers do not
change.

The console stores this encrypted:

```jsonc
{
  "credential": {
    "algorithm": "aes-256-gcm",
    "iv": "...",
    "tag": "...",
    "ciphertext": "..."
  }
}
```

It never stores the plaintext in `state.json`, the audit log, or an HTML response.

## Codex account authorization

A Codex account is registered in the dashboard like a Claude one — alias, and optionally the
subscription's email address — and receives its own permanent **Codex authorization** page.
`node cli.js import-codex` remains available for a home that is already seeded.

On that page an administrator:

1. selects **Start a fresh authorization**;
2. opens the generated OpenAI link and signs in with the ChatGPT account that holds the Codex
   subscription;
3. **lets the browser fail.** The Codex OAuth client is registered against
   `http://localhost:1455/auth/callback`, and nothing is listening there. "Unable to connect"
   is the successful outcome, not a fault: the authorization code is in the address bar;
4. pastes that whole address — or just the code — back into the page within 15 minutes and
   selects **Complete authorization**.

A pasted address carries the state, and the server verifies it against the digest it issued. A
bare code carries no state — it is accepted against the account's single live session, and its
binding to this console is PKCE alone. Either way the server exchanges the code directly with
OpenAI, and refuses a response with no refresh token (a credential the centre could never rotate)
or no `id_token` (no account id). If the account carries an email label, a different authorized
email is rejected. Starting again supersedes every unfinished session for that account, sessions
are single-use, and the PKCE verifier is encrypted at rest exactly as in the Claude flow. The
resulting credential is never written to `state.json`, an audit entry, or a log line.

A failed attempt — a truncated paste, a wrong ChatGPT account — leaves the session live and the
paste box on the page, so the same code can be submitted again. **Start a fresh authorization**
supersedes it and invalidates the code already in hand; press it only after the session expires
or the code is genuinely gone.

Where the credential goes depends on one variable, and the two options trade off differently:

**`CREDENTIAL_CONSOLE_CODEX_SEED_HOME` unset (default).** The console writes nothing. The
finished `auth.json` is rendered once, with copy and download buttons and the exact `seed.js`
command to run on the refresh centre. Leaving the page hides it permanently; there is no second
render. This keeps the console's relationship with every `codex-credential` home read-only.

**`CREDENTIAL_CONSOLE_CODEX_SEED_HOME=/var/lib/codex-credential`.** On completion the console
writes the credential into that home itself, reusing the refresh centre's own `CredentialStore`
and `expiryOf` — the same atomic write, the same generation retention, the same `public/` publish
step, and the same operation lock that `seed.js` takes. If that lock is held, the write stops with
`is busy, so nothing was written` rather than racing a refresh that may already have spent the
single-use token. The credential is never displayed. One home holds one credential, so an
authorization that would seed a home another account already holds is refused before it starts.

> **This contradicts the read-only import boundary described above and elsewhere in this
> README.** With the variable set, the console process needs write access to `secret/` in that
> home, so a console compromise reaches the Codex refresh token — which read-only import
> deliberately keeps out of reach. Set it only when the console and the refresh centre are the
> same trust domain, and prefer the copy/download path otherwise. It changes nothing about the
> dispenser or the client-token registry, which the console still never writes.

Either way the seed is a handover, not a backup. OpenAI rotates refresh tokens single-use, so
the centre's first rotation invalidates the credential produced here: a copied `auth.json` is
dead from that moment and must be deleted rather than archived, and re-seeding a running centre
from a stale file destroys the live credential.

## Member workflow

The default tailnet flow is fully self-service:

1. A member opens the console from a user-owned device in the tailnet.
2. Tailscale identifies the member; the console has no login of its own.
3. The member chooses an available Claude Code account and enters a device name.
4. The console issues and displays that device's macOS/Linux and Windows configurations once;
   both can be copied or downloaded.
5. The member runs the profile to start `claude`.

No administrator needs to create or deliver an enrollment link. The member receives only a
per-device console token, never the provider OAuth token.

In `open` mode the same zone renders for an anonymous visitor. There is no identity to show, so
the member types a label of their own instead; it only namespaces device names so that two people
enrolling `laptop` do not revoke each other. Nothing verifies it.

One-time links remain available for exceptional cases where an administrator needs to
prepare access for somebody else:

1. An administrator chooses a Claude account, enters the member label, and creates an
   enrollment link.
2. The member opens the link within 30 minutes, names the device, and redeems it once.
3. The result page shows a per-device profile once.
4. The member runs that profile to start `claude`.
5. The administrator can revoke that one device without rotating the provider credential or
   interrupting other members.

The macOS/Linux client stores the per-device token in a mode-600 file. Its launcher reads the
token only while starting Claude Code's explicit gateway mode. The generated profile is
equivalent to:

```bash
export ANTHROPIC_BASE_URL=https://<public-claude-gateway>/claude
export ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5
export CLAUDE_CODE_USE_GATEWAY=1
export CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1
unset ANTHROPIC_AUTH_TOKEN ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN
export ANTHROPIC_AUTH_TOKEN="$(cat ~/.config/claude-codex-gateway/claude-<profile>.token)"
~/.local/bin/claude-gateway
```

The installer also creates a stable `claude-gateway-api-key-helper` alias for legacy managed
launchers. It does not register that helper in Claude settings because explicit gateway mode
uses `ANTHROPIC_AUTH_TOKEN`; registering both makes Claude Code warn about ambiguous auth.

The helper output and the launcher's `ANTHROPIC_AUTH_TOKEN` are the console's per-device token,
not an Anthropic token. `CLAUDE_CODE_USE_GATEWAY=1` prevents current Claude Code releases from
performing only the gateway health probe and then routing model requests to Anthropic directly.
`ANTHROPIC_DEFAULT_OPUS_MODEL=claude-opus-5` keeps Claude Code's `opus` alias and default model on
Opus 5; Claude Code 2.1.223 otherwise resolves that alias to Opus 4.7 even though the same account
and gateway can successfully use the exact `claude-opus-5` model ID.
`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` prevents normal environment inheritance into Bash, hooks,
and MCP processes without forcing Linux devices to install `bubblewrap` and `socat`. This
lightweight mode is not an OS security boundary: a command running as the same local user can
still invoke the helper, inspect the Claude process, or read its mode-600 token file. The gateway
limits that exposure to one independently revocable device credential; managed workspaces can
add an OS/container sandbox separately.

For Codex, the member flow is similar:

1. Enter a device name; operating-system choice is deferred to the result page.
2. The console presents the low-privilege enrollment key to the dispenser on the server side.
3. The dispenser returns an independently revocable bearer token for that device.
4. The console renders macOS, Linux, and Windows self-contained installers together. The member
   chooses exactly one for the enrolled device, copies or downloads it, and runs it locally; it
   does not fetch code from the private console.
5. The installed client agent immediately writes `~/.codex/auth.json` and registers an
   unattended refresh timer.

The shared enrollment key never appears in the browser or installer. The downloaded script
contains only the newly minted device token, dispenser endpoint, and TLS certificate pin. The
agent still requires the member machine to reach `chatgpt.com/backend-api/`; credentials do not
replace network egress.

## Security boundaries

- `master.key`, `state.json`, and the data directory are mode 600/700.
- Provider credentials use AES-256-GCM with account-specific authenticated data.
- There are exactly two administrator-auth modes, `tailscale` and `open`, and the console has
  no login of its own in either: no password, no sign-in page, and no `/login` or `/logout`
  route. `CREDENTIAL_CONSOLE_ADMIN_AUTH` defaults to `tailscale`, so an unconfigured
  deployment refuses a request that carries no tailnet identity rather than serving it.
- `open` administrator-auth mode has no authentication at all: no identity of any kind. Every
  client that can open the console is an administrator and can add accounts, issue device
  credentials, and revoke them. Reaching the console is then the entire authorization boundary,
  so it belongs only on a private overlay network whose membership you already control. Every
  page states this, `/health` reports `admin_configured: false`, and audit entries in this mode
  record the self-asserted member label, not a verified identity. It follows that the
  per-administrator binding on Claude and Codex authorization sessions is a no-op here: with no
  identity to bind to, every visitor is recorded as the same `administrator`, so any visitor can
  complete an authorization another visitor started. PKCE, the single live session, and the
  15-minute expiry are what remain.
- Session CSRF tokens are enforced in `open` mode exactly as in `tailscale` mode. They are
  unrelated to any login, and without them any web page a visitor opens could drive the console
  from their browser.
- Tailscale-mode administration trusts `Tailscale-User-Login` only from the loopback
  Tailscale Serve proxy; Serve removes spoofed identity headers before forwarding.
- Administrator sessions are in memory, expire after 12 hours, and use
  `HttpOnly; Secure; SameSite=Strict` cookies in production.
- State-changing administrator actions require a session-specific CSRF token.
- Enrollment codes are stored only as SHA-256 digests, expire after 30 minutes, and are
  single-use.
- Claude authorization verifiers are encrypted at rest, authorization states are stored only
  as SHA-256 digests, and unfinished sessions expire after 15 minutes or are superseded when a
  new session starts.
- A completed Claude authorization is accepted only when Anthropic reports the account email
  configured for that row.
- Codex authorization reuses that same mechanism — encrypted verifier, single-use, superseded,
  15-minute expiry — with one documented exception: a pasted address is checked against the
  digested state, a bare code is not and rests on PKCE plus the single live session. The
  resulting `auth.json` is either handed to the operator once or written into a
  `codex-credential` home; it never reaches `state.json`, an audit entry, or a log line, and no
  page can re-render it.
- Setting `CREDENTIAL_CONSOLE_CODEX_SEED_HOME` deliberately gives the console write access to
  that home's `secret/`, which read-only import otherwise denies it. Unset, the console never
  reads or writes the refresh token stored in a `codex-credential` home — it does still hold a
  newly authorized refresh token in memory for the length of one request and render it to the
  operator once.
- Device bearer tokens are stored only as SHA-256 digests and compared in constant time.
- Codex enrollment uses the dispenser's mint-only shared key on the server side. The key cannot
  read the current Codex credential, and each minted token is independently revocable.
- The gateway allowlists paths and strips the device authorization header before attaching
  the provider credential. `GET /claude/api/hello` is an unauthenticated health probe that
  returns a fixed response; every other path requires a valid device token.
- The public gateway rate-limits failed authentication by source IP and applies per-device
  request and concurrency budgets after authentication.
- Prompt and response bodies are streamed and never logged.
- Revocation is checked on every request.
- The server refuses a non-loopback bind without TLS. Production runs loopback-only behind
  Tailscale Serve.

The credential center is intentionally a high-value host. A root compromise of the center
can recover all active provider credentials. Keep OS access narrow, patch the host, and
retain an emergency service-stop and provider-token revocation procedure.

## Runtime configuration

| Variable | Default | Purpose |
|---|---|---|
| `CREDENTIAL_CONSOLE_HOME` | `/var/lib/credential-console` | State and encryption key |
| `CREDENTIAL_CONSOLE_BIND` | `127.0.0.1` | Listen address |
| `CREDENTIAL_CONSOLE_PORT` | `9443` | Listen port |
| `CREDENTIAL_CONSOLE_PUBLIC_URL` | `https://127.0.0.1:<port>` | Tailnet-only console and enrollment-link origin |
| `CREDENTIAL_CONSOLE_CLAUDE_GATEWAY_URL` | `<PUBLIC_URL>/claude` | Public Claude gateway URL embedded in device profiles |
| `CREDENTIAL_CONSOLE_ADMIN_AUTH` | `tailscale` | Administrator auth: `tailscale` (Tailscale user identity) or `open` (no authentication at all). The default fails closed; `open` must be chosen deliberately |
| `CREDENTIAL_CONSOLE_COOKIE_SECURE` | `1` | Set `0` only for loopback tests |
| `CREDENTIAL_CONSOLE_TLS_CERT` | — | Direct-TLS certificate path |
| `CREDENTIAL_CONSOLE_TLS_KEY` | — | Direct-TLS key path |
| `CREDENTIAL_CONSOLE_CODEX_ENDPOINT` | — | Codex dispenser URL used by the console and generated installers |
| `CREDENTIAL_CONSOLE_CODEX_CERT_PIN` | — | SHA-256 pin for the dispenser TLS certificate |
| `CREDENTIAL_CONSOLE_CODEX_ENROLLMENT_KEY_FILE` | — | Mode-640 file containing the dispenser's mint-only enrollment key |
| `CREDENTIAL_CONSOLE_CODEX_SEED_HOME` | — | `codex-credential` home a completed Codex authorization writes into. Unset means show the `auth.json` once instead; setting it makes the console a **writer** of that home |
| `CREDENTIAL_CONSOLE_USAGE_REFRESH_INTERVAL_MS` | `3600000` | Provider quota refresh interval (minimum 60 seconds) |

Quota polling calls the read-only provider endpoints used behind Claude Code and Codex status
surfaces; it does not submit a model turn. Normalized snapshots are stored in mode-600
`usage.json`, never with an OAuth or device token. A provider may omit a window (a Codex response
can contain a weekly window without a five-hour window); the UI reports that as not provided
rather than estimating it. Failed refreshes retain and mark the last successful snapshot as
stale.

The recommended deployment uses Tailscale Serve on port 443 for the tailnet-only control plane
and Tailscale Funnel on a different port for only the `/claude` gateway mount. The shipped
systemd unit keeps the Node service on `127.0.0.1:9080`, so the direct TLS variables are unset.
In `tailscale` administrator-auth mode,
every user-owned device allowed to reach the Serve endpoint receives administrator access. In
`open` mode every client that can reach the listener does, with no identity at all.
Funnel traffic has no Tailscale identity and can reach only the device-token-authenticated data
plane. Tagged devices do not receive Tailscale user identity headers and are refused by the
control plane.

## CLI

On a genuine first deployment, initialize the master key before starting the service:

```bash
export CREDENTIAL_CONSOLE_HOME=/var/lib/credential-console
node cli.js init-key
```

Use `init-key` only for an empty, genuine first deployment. If `master.key` is missing while the
home contains encrypted data, the command exits non-zero, writes nothing, and reports:
`credential home already contains data encrypted under a different key; a new key cannot decrypt
it; restore master.key from backup instead`. Restore the key from backup; never create a new key
for that home.

There is no administrator credential to bootstrap. The console identifies administrators from
Tailscale, or not at all — see [Runtime configuration](#runtime-configuration).

Import an existing Codex credential service:

```bash
sudo systemctl stop credential-console
node cli.js import-codex \
  --alias codex-shared-1 \
  --home /var/lib/codex-credential \
  --email owner@example.com
sudo systemctl start credential-console
```

The import stores only the external home path. At dashboard render time the service reads
`public/current.json`. It has no production access to the client-token registry, and none to
`secret/` unless `CREDENTIAL_CONSOLE_CODEX_SEED_HOME` names that home — see
[Codex account authorization](#codex-account-authorization).

List public account metadata:

```bash
node cli.js list
```

The server holds the credential home's single-writer lock for its lifetime. `init-key` and
`import-codex` fail fast while the service is running; `list` is read-only and unlocked.

## Deployment

See [`DEPLOY.md`](DEPLOY.md). The recommended deployment keeps the UI and enrollment pages in
the tailnet, publishes only the Claude gateway through Funnel, and uses the pinned public Codex
dispenser on TCP 8443. Follow its backup, restore verification, restore, and rollback procedure
for the credential home; losing `master.key` makes every stored Claude OAuth credential
unrecoverable.

## Tests

```bash
npm test
```

The suite proves that:

- provider tokens do not appear in `state.json` or dashboard HTML;
- credentials decrypt after restart;
- enrollment is single-use;
- Claude authorization state is single-use, its PKCE verifier is encrypted at rest, and an
  account-email mismatch cannot replace the stored credential;
- the administrator mode defaults to `tailscale` when `CREDENTIAL_CONSOLE_ADMIN_AUTH` is unset,
  and an unidentified visitor is then refused;
- neither surviving mode serves `/login` or `/logout`, and no page offers a sign-out;
- a Tailscale identity can self-issue a device credential without an enrollment link;
- a Tailscale identity can self-enroll a Codex device once and choose any platform installer;
- device tokens are independently revocable;
- CSRF bypasses are rejected;
- unsupported gateway paths are rejected;
- repeated public gateway authentication failures are rate-limited;
- the gateway sends the provider token upstream, not the member's device token.
