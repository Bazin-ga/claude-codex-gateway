# claude-codex-gateway

**English** | [简体中文](README.zh-CN.md)

> **Telemetry notice:** `credential-console` records metadata for every proxied Claude gateway
> request, including four provider-reported token counts, and makes those metrics visible to every
> member who can reach the console. Request and response bodies are not stored by this release.

A self-hostable credential distribution centre for **Codex** (ChatGPT subscription) and
**Claude Code** subscriptions.

One human logs in once. Every machine and every team member gets working access, without
anyone receiving a reusable provider OAuth credential, and without the copies knocking each
other out.

## The problem

**Codex.** A Codex subscription credential (`~/.codex/auth.json`) carries a `refresh_token`
that the provider rotates **single-use**: the instant one machine refreshes, every other copy
of that token dies permanently — silently, with no diagnostic signal. Copying one `auth.json`
to every machine therefore self-destructs, and a stored seed goes stale the same way, so
freshly-provisioned machines receive a dead credential too.

**Claude Code.** The credential a member would need is a long-lived provider OAuth token.
Handing it out means handing out an account. It cannot be revoked for one device, it cannot be
scoped, and it survives on any machine it touched.

Both cases need the same shape of answer: hold the real credential in exactly one place, and
give everyone else something that works for its intended purpose and is useless for anything
else.

## The mechanism

`codex-credential` keeps exactly **one** holder of a working `refresh_token` and distributes a
credential that is *structurally incapable of refreshing* — so no client can ever rotate the
centre's token away.

`credential-console` keeps Claude OAuth tokens encrypted at rest and never lets them leave the
host. Devices authenticate to a gateway with a per-device token; the gateway strips that token
and attaches the device's currently selected, server-held provider credential upstream. A device
can inspect its own status and switch among accounts an administrator has allowed, without a new
credential or access to any other device.

```
                              ┌──────────────────────────────────────────┐
                              │  provider                                │
                              │  auth.openai.com/oauth/token             │
                              │  chatgpt.com/backend-api/codex/responses │
                              │  api.anthropic.com                       │
                              └───────▲───────────────────▲──────────────┘
                                      │                   │
  ═════ centre host (direct egress) ══╪═══════════════════╪═══════════════════════
                                      │                   │
   ┌──────────────────────────┐       │       ┌───────────┴──────────────────┐
   │ refresh-center           ├───────┘       │ credential-console           │
   │ sole holder of a working │               │ encrypted Claude OAuth store │
   │ refresh_token; persists  │               │ + admin UI + enrollment      │
   │ each rotation atomically │               │ + /claude gateway            │
   └───────────┬──────────────┘               └────┬──────────────────┬──────┘
               │ access_token only                 │                  │
   ┌───────────▼──────────────┐                    │ read-only import │
   │ token-dispenser          │◄───────────────────┘ (expiry, client  │
   │ POST /enroll  → machine  │  server-side mint     count; never the│
   │                  token   │                       refresh token)  │
   │ GET  /credential → never │                                       │
   │        a refresh_token   │                                       │
   └───────────┬──────────────┘                                       │
               │                                                      │
  ═════════════╪══════════════════════════════════════════════════════╪═════════
               │ pull before expiry                    device token    │
   ┌───────────▼──────────────┐                     ┌─────────────────▼────────┐
   │ client-agent             │                     │ member device            │
   │ writes ~/.codex/auth.json│                     │ claude → gateway → API   │
   │ refresh_token = INVALID  │                     │ holds only a per-device  │
   │ value (never absent)     │                     │ token, never provider    │
   └──────────────────────────┘                     └──────────────────────────┘
```

Control-plane surfaces (admin UI, enrollment pages) are meant to stay on a private network.
Only the token-authenticated data planes — the Codex dispenser and the `/claude` gateway —
face the public internet.

## Components

| Family | Contents | Docs |
|---|---|---|
| [`codex-credential/`](codex-credential/) | `refresh-center`, `token-dispenser`, `client-agent`. Distributes one Codex credential to many machines without mutual eviction. | [README](codex-credential/README.md) · [DEPLOY](codex-credential/DEPLOY.md) |
| [`credential-console/`](credential-console/) | Multi-account control plane, per-device enrollment and account switching, encrypted Claude OAuth storage, credential-isolating Claude gateway. Imports an existing `codex-credential` home read-only, and can authorize a Codex account itself. | [README](credential-console/README.md) · [DEPLOY](credential-console/DEPLOY.md) |

The two families are independent. Deploying `codex-credential` alone is a complete story;
`credential-console` adds Claude accounts, a UI, and self-service enrollment on top.

## Requirements

- **Node ≥ 22.5** on a centre host that runs `credential-console`; the Codex-only centre and
  client agents require **Node ≥ 20**. There are no runtime npm dependencies.
- A centre host with **direct egress** to `auth.openai.com` — some networks answer `403`
  there, and such a host cannot serve as the centre. Verify with a deliberately invalid
  refresh before committing to a host.
- Every client machine needs direct egress to `chatgpt.com/backend-api/`. Credentials do not
  replace network reachability, and these are two distinct egress requirements.
- For Claude accounts: reachability of the Anthropic API from the centre host.
- Recommended: a private overlay network (for example Tailscale) so the control plane never
  needs a public listener. See the deployment guides for the Serve/Funnel topology.

## Start here

1. If an AI is helping configure a member machine, read the public
   [`AI onboarding guide`](AI-ONBOARDING.md) first. It requires joining the tailnet before
   opening the private console and never contains deployment secrets.
2. Read [`QUICKSTART.md`](QUICKSTART.md) for the shortest path from nothing to a working
   client.
3. Then [`codex-credential/DEPLOY.md`](codex-credential/DEPLOY.md) — the server, the one-time
   human login, and the per-machine agent.
4. Then, if you want Claude accounts and a UI,
   [`credential-console/DEPLOY.md`](credential-console/DEPLOY.md) — network topology,
   administrator auth, member self-service, and the backup/restore/rollback procedure.

Read the backup and restore sections before you have anything worth losing. Losing the
centre's `refresh_token` means asking a human to log in again. Losing the console's
`master.key` makes every stored Claude OAuth credential unrecoverable.

## Security model, briefly

- **One holder.** Exactly one process holds a working Codex `refresh_token`. Provider OAuth
  tokens for Claude are AES-256-GCM encrypted at rest under a separate mode-600 master key and
  are never rendered after submission.
- **Structural, not filtered.** The dispenser does not read the `refresh_token` field at all,
  so no code path through it can return one. The enrollment handler never opens the published
  credential, so a leaked enrollment key mints machine tokens and nothing else.
- **Per-device credentials.** Every machine and every member device gets its own bearer token,
  stored only as a SHA-256 digest, independently revocable, checked on every request. The same
  token authenticates a self-only control API; it cannot inspect or switch another device.
- **Split planes.** Control plane private; only token-authenticated data planes public. The
  Claude gateway allowlists paths, strips the device authorization header before attaching the
  provider credential, rate-limits failed authentication by source IP, and applies per-device
  request and concurrency budgets.
- **Body-free request telemetry.** The Claude gateway persists request metadata and separate input,
  cache-creation input, cache-read input, and output token counts for shared metrics. Request and
  response bodies are streamed and are neither logged nor stored.
- **The centre is a high-value host by design.** A root compromise of the centre can recover
  all active provider credentials. Keep OS access narrow, patch it, and keep an emergency
  service-stop and provider-token revocation procedure.

The per-device client-side isolation on member machines is not an OS security boundary: a
command running as the same local user can read the mode-600 token file. What it buys is that
the blast radius is one revocable device credential rather than the account.

## Status / what is not verified

The codex-cli behaviours the design depends on were measured directly, not assumed; the table
in [`codex-credential/README.md`](codex-credential/README.md) lists each fact with its
evidence. The decisive one — that the distributed credential shape drives a real turn while
leaving `auth.json` byte-identical — was observed end to end.

Not verified:

- **whether many machines sharing one subscription draws provider attention.** Concurrent use
  of a single access token succeeded, but from a single host and IP, which does not probe
  vendor-side sharing detection. Whether this arrangement is compatible with your provider
  agreement is your call to make, not something this repository establishes.
- **long-run behaviour across provider changes.** These are undocumented endpoints. A provider
  change can invalidate a measured fact at any time; re-verify rather than trusting the table
  indefinitely.
- **any performance or scale claim.** None is made here. Nothing in this repository has been
  load-tested.

`codex-cli` version numbers matter: the measurements were taken against a specific release,
noted in the family README.

## Licence

MIT. See [`LICENSE`](LICENSE).
