# credential-console

Multi-account control plane for subscription-backed Codex and Claude Code access.

> **Telemetry and conversation notice:** every proxied Claude gateway request produces a persistent
> metadata row that is visible to every member who can reach the console. It includes routing, model,
> status, timing, byte-count, and four provider-reported token-count fields. P6 permanently stores
> every captured conversation turn from Claude and makes its prompt/reply text visible to everyone who can
> reach the console; in `open` mode that means anyone on the tailnet, with no identity and no reading
> audit. Member labels are self-entered and unverified, so metrics must not be used for accountability
> or billing. Codex traffic is not covered by conversation capture.

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
- server-side account selection from the next request, with a CSRF-protected selector on each
  Claude credential and a device-token-authenticated, self-only machine control API;
- an optional opaque machine handle on a device record, and a dashboard that reads the device
  list as a machine inventory: one row per machine, its Claude and Codex credentials nested
  underneath, revoked ones collapsed, and rows without a handle flagged and one click from
  being filed under a machine — see [Machine inventory](#machine-inventory);
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
- a public generic AI onboarding document plus a live private Markdown guide with safe deployment
  metadata, exact read-only version checks, and a copyable dashboard link;
- persistent per-request metrics in a separate SQLite database, with server-rendered charts and
  filters, plus a permanent archive of eligible captured Claude conversation turns.

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

## AI onboarding and the private live guide

The repository's [`AI-ONBOARDING.md`](../AI-ONBOARDING.md) is the public, generic edition. It is
static documentation for a machine that has not joined the tailnet yet; it contains no deployment
address, account list, provider credential, device token, or control-plane command. It tells an AI
to join the approved tailnet first and then wait for a human to provide the private guide link.

After a member reaches the dashboard, the Administrator area shows a copyable link ending in
`/onboarding.md`. The **Copy guide link** button copies that exact link and **Open guide** fetches
the current Markdown. The route follows the same reachability/identity and session logic as the
console: Tailscale mode requires a tailnet identity, while an open-mode GET may create an anonymous
session. It returns Markdown/plain text, is not part of the public `/claude` gateway mount, and is
generated on every request from the current safe deployment metadata: configured console/gateway
addresses, account aliases, IDs and statuses, administrator mode, and client configuration version.
It never includes provider credentials, device tokens, token digests, audit history, or external
credential-home contents.

In `open` mode, reachability is the authorization boundary: anyone who can reach the console can
read this live guide and its endpoint/account metadata, as well as issue credentials and switch
active devices. Keep `open` behind the private overlay network. The member label remains
self-entered and unverified; it is not an actor identity. Tailscale mode still treats the guide as
tailnet-internal rather than public internet content.

Every generated Claude profile and Codex installer carries the server's client configuration
version. Compare stamps by exact equality. If the stamp is missing, stop and report that it is
absent; on a mismatch, stop and report both the installed and expected values. Never automatically
replace or downgrade the profile. After an operator explicitly approves it, generate a fresh
profile/installer; never repair a profile by copying a secret into it. An AI may execute a generated
secret-bearing installer locally only after the human explicitly authorizes that execution. It must
not print, upload, or paste the installer, its secret, or secret-bearing output back into the
conversation.

## Claude token accounting

The P5 token view extends the existing body-free request metrics for Claude gateway traffic only;
Codex clients connect directly to their provider and are outside this accounting boundary. It shows
four separate categories: input, cache-creation input, cache-read input, and output tokens. The
`count_tokens` and `/v1/models` helper endpoints are not consumption records.

The client-facing response remains the original encoded byte stream. One bounded observation tee
decodes identity, gzip, brotli, or deflate only on the metrics side; decoder/parser failure or a
global observation-budget limit disables token extraction for that response without changing its
status, headers, bytes, or backpressure. Streaming `message_delta.usage` values are cumulative, so
the last valid value replaces the earlier snapshot rather than being added to it. Non-streaming
JSON uses the same nullable four-field contract.

Each total is paired with a known-value count. A `0` means a measured known zero; `—` means the
total is unknown, never zero. Complete, partial, and unavailable usage-record counts are shown next
to the totals. If any usage record is partial or unavailable, the displayed token sum is explicitly
a lower bound and unknown values are not silently filled in. A complete record may still have
provider-null cache categories; those are labelled complete with category values unknown, not as a
transport/parser failure. The hourly table repeats the four token columns and coverage state, while
the separate token SVG leaves unknown hourly points blank instead of drawing them at zero. If a
synthetic/lifetime aggregate exceeds JavaScript's exact-integer range,
the page reports that overflow instead of rounding it or failing the entire metrics query; the
per-request integer rows remain stored.

The metrics page remains body-free: request and response bodies are not rendered there. P6 separately
permanently stores eligible captured Claude conversation turns and exposes them through the captured
conversation archive to every member who can reach the console; in `open` mode that means anyone on
the tailnet, with no identity and no reading audit. Self-entered member labels remain unverified and
must not be used for accountability or billing. Codex traffic is not covered by conversation capture.

The first P5 start migrates `metrics.sqlite` from schema 1 to schema 2 in one transaction; old rows
remain readable with unknown token values. The first P6 start then migrates schema 2 to schema 3 in
one transaction, adding the permanent conversation tables and full-text index; existing request rows
remain readable and simply have no conversation turn. A pre-P5 or pre-P6 binary deliberately refuses
the newer metrics schema. To roll code back, stop the console and restore only `metrics.sqlite` from
the matching checkpointed backup (removing its `-wal`/`-shm` sidecars); do not replace `master.key`
or `state.json` merely to roll back metrics code or conversation UI.

## Captured conversations

P6 permanently retains the prompt and reply text for eligible Claude turns and makes the archive
available to every member who can reach the console. The list supports full-text search and keyset
pagination; opening a row shows the complete stored text with its `complete`, `incomplete`,
`truncated`, or `unavailable` response state. A bounded capture queue can drop a conversation before
it is stored; the archive reports that condition prominently rather than implying that the turn was
saved. Codex traffic does not pass through this gateway and is not covered.

This is a deliberate disclosure, not an access-control boundary. In `open` mode, anyone on the
tailnet who can reach the console can read every captured conversation; there is no identity and no
reading audit. Member labels are self-entered and unverified and do not identify an actor. Treat the
conversation archive and its backups as permanent sensitive content.

Search validation is intentionally bounded for large archives: if a query is too short or has no
indexed terms, enter at least three consecutive Chinese characters, remove standalone punctuation,
or split the query into simpler terms. Other search failures use a fixed generic error message.

## Machine inventory

A device row records one credential *issuance*, not a machine. It is identified by a
self-asserted member label plus a name somebody typed; revoking it only marks the row. Its
original `account_id` remains immutable, while additive policy fields select another allowed
account without issuing a new token. Older deployments had no policy fields, so moving a machine
to another account appended a second row and the flat list only ever grew.

The dashboard groups it by the opaque handle a machine's own agent reports
([`../codex-credential/client-agent/lib/machine-id.js`](../codex-credential/client-agent/lib/machine-id.js)).
Each machine is one row with every credential it holds underneath, from both paths:

- **Claude** credentials come from this console's own `state.json`.
- **Codex** machines never contact this console — they enrol against the dispenser and pull
  from it directly — so their rows are read out of that home's `clients/clients.json`,
  read-only, the same way an imported account's expiry is. A home the console cannot read
  costs its own machines from the list and nothing else; the page says so and still renders
  everything it knows. A home with no `clients/` yet is not a failure — it means nothing has
  enrolled — and produces no warning. The shipped systemd unit must keep `clients/` under
  `ReadOnlyPaths=`; see [DEPLOY.md](DEPLOY.md).

Codex credentials this console mints on a member's behalf ("Set up a Codex machine") carry a
handle the **console** generated for that issuance, not one the machine reported: the
generated installer runs `pull.js`, never `enroll.js`, so such a machine never reaches
`/enroll` and has nothing of its own to report. Without one, the dispenser fell back to its
pre-handle rule and revoked every credential sharing that row's name — and since the name is
`<device>-<sha256(member label)[0:10]>` over a self-asserted label, two people who both typed
`alex` and `shared` silently evicted each other. The cost of fixing it is stated where it
falls: a member who re-requests a config for the same device gets a new handle, so their
previous console-minted credential stays active rather than being revoked. Retire it with
`add-client.js --revoke` on the dispenser host. Rows minted before this carry no handle at all
and stay unattributed permanently; the note on the row says so.

Two things it deliberately does not do:

- **It never merges rows on a matching name or member label.** Both are typed by a person and
  neither is verified, so folding them together would put two people's laptops in one row and
  call it inventory. A row with no handle is its own entry, labelled as unattributed.
- **It does not describe a handle as identifying a person.** This deployment authenticates
  nobody and the member label beside it is self-asserted, which makes the handle the only
  identifier here that a user cannot trivially forge — and it still says nothing about who is
  using the machine. It is random bytes generated once, by the agent on that machine or by the
  console for that one issuance: not a hostname, a username, a MAC address, or a serial
  number.

Revoked credentials are the majority of rows over time, so they are collapsed rather than
dropped: each machine folds its own revoked credentials away, and a machine holding nothing
live folds into "machines with no active credential". Everything remains one click away.

Account status and credential status are two columns, in two vocabularies. A healthy account
holding a revoked credential is the normal end state of a retired laptop, and previously read
as a fault.

### Merging a legacy row

The Claude path has no client agent — the member's browser cannot report a handle — so every
Claude credential starts unattributed. An operator who knows that a given credential and a
given machine are the same box can file it there with one control, restricted to machines the
page is already showing.

`POST /devices/:id/machine` is CSRF-protected like revoke and delete, and is the narrowest
write in the store: it adds `machine_id` to one device row. No account is read or touched, no
credential is re-encrypted, and no other row moves. A row that already carries the requested
handle is already where it is being asked to go, so a repeated submission writes nothing and
records nothing; a row carrying a *different* handle is refused outright rather than
reassigned. There is no un-merge — revoke the credential instead.

## Server-side account switching

Every active Claude credential row has its own account selector. The CSRF-protected console action
adds the chosen registered Claude account to that exact device's allowlist and selects it; it never
changes the immutable original `account_id`, reissues the device token, re-encrypts a provider
credential, or touches another row sharing the same machine handle. The next request resolves the
new selection. A request already in flight keeps the account it resolved at its start.

Device rows written before this feature have neither `allowed_account_ids` nor
`selected_account_id` and continue to use their original account without being rewritten. Once
either policy field exists, malformed or inconsistent policy is surfaced as an error rather than
silently guessed. A selected account that is registered but not yet authorized remains selected;
the gateway then returns its existing account-login-required response.

The machine control API lives under the same token-authenticated `/claude` runtime mount:

```text
GET  /claude/control/v1/status
POST /claude/control/v1/account
     {"account_id":"<allowed-account-id>"}
```

It accepts the device's existing `Authorization: Bearer` or `X-Api-Key` token, checks revocation on
every call, derives the target device exclusively from that token, and never accepts a device ID in
the URL or body. The status response is a safe device/account summary without tokens, digests,
credentials or audit history. A machine may switch only among accounts already granted from the
console. There is deliberately no machine-control enroll endpoint: a new machine still receives
its first device token through the existing console self-service page.

## Security boundaries

- `master.key`, `state.json`, and the data directory are mode 600/700.
- Provider credentials use AES-256-GCM with account-specific authenticated data.
- There are exactly two administrator-auth modes, `tailscale` and `open`, and the console has
  no login of its own in either: no password, no sign-in page, and no `/login` or `/logout`
  route. `CREDENTIAL_CONSOLE_ADMIN_AUTH` defaults to `tailscale`, so an unconfigured
  deployment refuses a request that carries no tailnet identity rather than serving it.
- `open` administrator-auth mode has no authentication at all: no identity of any kind. Every
  client that can open the console is an administrator and can add accounts, issue device
  credentials, switch any active Claude device, and revoke them. Reaching the console is then the entire authorization boundary,
  so it belongs only on a private overlay network whose membership you already control. Every
  page states this, `/health` reports `admin_configured: false`, and account-switch audit entries in
  this mode record `anonymous`; the self-asserted member label is attribution, not an actor. It follows that the
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
- Prompt and response bodies are streamed; eligible Claude turns are permanently retained in the
  conversation archive and visible to every console-reachable member, while routing, model, status,
  timing, and byte-count metadata remains visible on `/metrics`. Codex traffic is outside capture.
- TTFB is measured when the upstream response headers arrive (the first HTTP response bytes).
  Request and response byte counts are raw body bytes observed by the gateway; an interrupted row
  therefore contains the partial count observed before the terminal event.
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
The dashboard's `/onboarding.md` guide is served only through that session-bearing control-plane
surface; it is not a Funnel route. It is safe to copy the link from the dashboard, but never move
it to the public gateway mount.
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

After stopping the service, checkpoint and integrity-check the request-metrics database before a
file-level backup:

```bash
export CREDENTIAL_CONSOLE_HOME=/var/lib/credential-console
node --no-warnings cli.js checkpoint-metrics
```

The command is a no-op when `metrics.sqlite` does not exist. It refuses a busy checkpoint or a
failed SQLite integrity check; do not copy only the main database file after either failure.

Import an existing Codex credential service:

```bash
sudo systemctl stop credential-console
node cli.js import-codex \
  --alias codex-shared-1 \
  --home /var/lib/codex-credential \
  --email owner@example.com
sudo systemctl start credential-console
```

The import stores only the external home path. At dashboard render time the service reads two
files out of that home, both read-only: `public/current.json` for the credential's expiry, and
`clients/clients.json` for the machine inventory — `token_sha256` is dropped at the read
boundary, so no bearer digest reaches a rendered page. It never writes either, and has no
access to `secret/` unless `CREDENTIAL_CONSOLE_CODEX_SEED_HOME` names that home — see
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
- a `state.json` written before machine handles existed still opens, still decrypts its stored
  credential under the same key and authenticated data, and is not rewritten by opening it;
- the dashboard groups credentials into machines and reads Codex machines out of a dispenser
  home, rows without a handle stay separate and labelled, and a home it cannot read degrades
  the list instead of failing the page;
- merging a legacy row adds one field and is idempotent, CSRF-protected, refused for an
  unknown machine, and refused outright for a row already attributed elsewhere;
- a revoked credential does not change how its account renders;
- CSRF bypasses are rejected;
- unsupported gateway paths are rejected;
- repeated public gateway authentication failures are rate-limited;
- the gateway sends the provider token upstream, not the member's device token.
