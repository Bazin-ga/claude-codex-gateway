# Quickstart — one Linux host, no root

A linear walkthrough that gets `codex-credential` running end to end on a single host you
own: one refresh center, one dispenser, one client. No system users, no Tailscale, no
`sudo`. Everything lives under your own `$HOME` and listens on an unprivileged port.

This is a starting configuration, not the hardened one. It deliberately collapses the two
Unix identities that [`codex-credential/DEPLOY.md`](codex-credential/DEPLOY.md) keeps
separate: here the dispenser process runs as you, so nothing but file permissions stops it
from reading the refresh token. That boundary is real and worth restoring — see
[Where to go next](#11-where-to-go-next) — but it is not what you need in the first ten
minutes.

Placeholders used below: `<center-host>` is the address clients will dial (an IP or a DNS
name), `<pin>` is the certificate fingerprint `gen-cert.sh` prints, `<key>` is the
enrollment key `set-enrollment-key.js` prints.

---

## 1. Prerequisites

- Node ≥ 20. Nothing else: all three packages are dependency-free, so there is no
  `npm install` step.
- One `auth.json` produced by a human `codex login` on a machine that can reach ChatGPT.
  It must be a subscription login — `auth_mode: "chatgpt"` with a non-empty
  `tokens.refresh_token`. `seed.js` refuses anything else.
- **Do not run `codex login` on the center host.** It wipes the existing credential
  *before* waiting for authorization, so an interrupted login destroys it with no
  recovery. The center never needs the codex CLI.

### Two distinct egress requirements

They are different hosts and different destinations. Check both before anything else.

**The center needs `auth.openai.com`.** It is the only component that performs the OAuth
refresh. Probe it with a deliberately invalid refresh token:

```bash
curl -s -w '\n%{http_code}\n' -X POST https://auth.openai.com/oauth/token \
  -H 'Content-Type: application/json' \
  -d '{"client_id":"app_EMoamEEZ73f0CkXaXp7hrann","grant_type":"refresh_token","refresh_token":"deliberately-invalid"}'
```

A good answer is an HTTP status with a small JSON error body — `401` is what an invalid
refresh token earns. That means the endpoint parsed the request and rejected the
credential, which is exactly the signal you want: the request shape is right and the path
is open. A bad answer is `000` (no connection at all), or an HTML body instead of JSON,
which means an interstitial is standing between this host and the endpoint. Either way
this host cannot serve as the center.

**Every client needs `chatgpt.com/backend-api/`.** The dispenser supplies credentials, not
connectivity; a machine with a perfect credential and no route still fails. Run this **in
a terminal, not a browser**:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://chatgpt.com/backend-api/codex/responses
```

`405` is the good answer — a bare `GET` on a `POST` route, which proves the request
arrived. `000` means it never got there. Note the destination: it is **not**
`api.openai.com`. A subscription token has no API-platform scope there and will be
rejected with `Missing scopes: api.responses.write` no matter how healthy it is.

A common false negative on the client: a VPN in system-proxy mode, which CLI programs
frequently ignore. The browser reaches ChatGPT, `curl` and `codex` do not, and the
credential gets blamed. Switch the VPN to TUN/global mode, or set `HTTPS_PROXY` explicitly
for codex.

### Get the code

```bash
git clone https://github.com/Bazin-ga/claude-codex-gateway.git ~/claude-codex-gateway
cd ~/claude-codex-gateway/codex-credential
```

Optional sanity check — each package carries its own tests and needs no network:

```bash
(cd refresh-center && node --test)
(cd token-dispenser && node --test)
(cd client-agent && node --test)
```

---

## 2. Choose a `CODEX_CRED_HOME`

Every tool in `codex-credential` reads `CODEX_CRED_HOME` and defaults to
`/var/lib/codex-credential`, which you cannot write to without root. Point it somewhere
you own and create it `0700` before seeding:

```bash
export CODEX_CRED_HOME="$HOME/codex-credential"
install -d -m 700 "$CODEX_CRED_HOME"
```

Export it in every shell that runs a center or dispenser command. Forgetting it is the
most common way to end up with two half-populated stores.

The tools create the rest of the layout themselves:

| Path | Written by | Holds |
|---|---|---|
| `secret/credential.json` | refresh-center | the real credential, **including the refresh token** |
| `secret/credential.*.bak.json` | refresh-center | the last 5 generations |
| `public/current.json` | refresh-center | access token, id token, account id, expiry — no refresh token |
| `clients/clients.json` | dispenser, `add-client.js` | per-machine token **digests** |
| `clients/enrollment.json` | `set-enrollment-key.js` | the enrollment key **digest** |
| `tls/server.{crt,key}` | `gen-cert.sh` | the dispenser's certificate |

---

## 3. Seed from `auth.json`

```bash
node refresh-center/seed.js /path/to/auth.json
```

It prints the store path, a short non-reversible fingerprint of the refresh token, and the
access token's expiry.

> **The source `auth.json` is a seed, not a backup.** OpenAI rotates refresh tokens
> single-use: the moment the center performs its first refresh, the token in that file is
> permanently dead. Copying it somewhere "just in case" gives you a file that looks like a
> credential and is not one. From this point the only live credential is
> `$CODEX_CRED_HOME/secret/credential.json`, and the only recovery from losing it is a
> fresh human `codex login` followed by another seed.

`seed.js` leaves the source file untouched and publishes `public/current.json` immediately,
so the dispenser has something to serve before the first refresh ever runs.

---

## 4. Generate the certificate and record the pin

The dispenser is reached by IP or by a name no CA vouches for, so it uses a self-signed
certificate and clients validate the exact fingerprint instead of a chain.

```bash
./token-dispenser/gen-cert.sh <center-host>        # optional second argument: validity in days, default 3650
```

Pass exactly what clients will dial. The script puts an IP in the SAN as `IP:` and anything
else as `DNS:`; a mismatch here yields a certificate some clients reject outright.

It prints the pin. **Record it** — every client needs it as `CODEX_CRED_CERT_PIN`. You can
recompute it at any time from the certificate:

```bash
openssl x509 -in "$CODEX_CRED_HOME/tls/server.crt" -outform DER |
  openssl dgst -sha256 -hex | awk '{print $NF}'
```

Regenerating the certificate changes the pin and every client refuses to connect until it
is updated. That refusal is the pin working, not a fault.

---

## 5. Mint a machine token, and enable self-service enrollment

Two ways to give a machine a bearer token. Do the first to prove the path works; do the
second so you never have to repeat the first.

**Hand-minted** — one token for one named machine:

```bash
node token-dispenser/add-client.js laptop     # prints the token, once
node token-dispenser/add-client.js --list
```

Only the SHA-256 digest is stored. The plaintext is shown exactly once and cannot be
recovered; to re-issue, `--revoke <name>` and mint again.

**Self-service** — a shared key that lets a machine mint its own token:

```bash
node token-dispenser/set-enrollment-key.js --generate   # prints the key, once
node token-dispenser/set-enrollment-key.js --status
```

The shared key is deliberately low-privilege: it mints a machine token and **nothing else**.
The enrollment handler never opens `public/current.json`, so no path through it can return
a credential. Every token it mints is per-machine, individually revocable, and logged with
a name and an IP; rotating the key leaves already-enrolled machines untouched. That is what
makes it distributable the way a configuration value is rather than the way a credential is.

Until you run this, `POST /enroll` answers `403` for every key — indistinguishable from a
wrong key, so probing cannot tell the two apart. `--disable` returns it to that state.

---

## 6. Start the dispenser and health-check it

`server.js` reads exactly two variables for its socket:

| Variable | Default | Meaning |
|---|---|---|
| `CODEX_CRED_BIND` | `0.0.0.0` | listen address |
| `CODEX_CRED_PORT` | `8443` | listen port |

Also `CODEX_CRED_HOME` (data directory) and `CODEX_CRED_TLS_CERT` / `CODEX_CRED_TLS_KEY`,
which default to `$CODEX_CRED_HOME/tls/server.crt` and `server.key`.

Port 8443 is above 1024, so no root is required. Run it in the foreground first:

```bash
node token-dispenser/server.js
```

It logs one JSON line per event, starting with `listening`. In another shell:

```bash
curl -sk https://127.0.0.1:8443/health
# {"status":"ok"}

curl -sk -o /dev/null -w '%{http_code}\n' https://127.0.0.1:8443/credential
# 401 — /health is deliberately unauthenticated and credential-free; /credential is not
```

If clients are on other machines, open the port in the host firewall and in any cloud
security group. The blast radius of that exposure is bounded by construction: the worst a
stolen client token yields is an access token valid for at most ~10 days that cannot be
renewed, and the dispenser never reads a refresh token at all.

---

## 7. Enroll a client and pull

Do this from the machine that will run codex. To rehearse on the center host itself, use
the isolated-`CODEX_HOME` trick below so you never touch a real `~/.codex/auth.json`.

Copy the agent to the client machine — plain JavaScript, no dependencies:

```bash
mkdir -p ~/.local/share/claude-codex-gateway
cp -r ~/claude-codex-gateway/codex-credential/client-agent ~/.local/share/claude-codex-gateway/
```

Enroll once. `enroll.js` requires all three of `CODEX_CRED_ENDPOINT`,
`CODEX_CRED_ENROLLMENT_KEY` and `CODEX_CRED_CERT_PIN`, and exits `2` naming whichever is
missing:

```bash
export CODEX_CRED_ENDPOINT=https://<center-host>:8443
export CODEX_CRED_CERT_PIN=<pin>
read -rs -p 'enrollment key: ' CODEX_CRED_ENROLLMENT_KEY; export CODEX_CRED_ENROLLMENT_KEY; echo

node ~/.local/share/claude-codex-gateway/client-agent/enroll.js
```

The prompted read is deliberate: `export CODEX_CRED_ENROLLMENT_KEY=<key>` typed at a prompt
lands verbatim in `~/.bash_history`, which outlives the session.

It logs `enrolled` and writes `~/.config/codex-credential.env` at mode 600 containing
`CODEX_CRED_ENDPOINT`, `CODEX_CRED_CERT_PIN` and the minted `CODEX_CRED_TOKEN`. The token
itself is never logged. `CODEX_CRED_NAME` overrides the machine name, which otherwise comes
from the hostname; `CODEX_CRED_ENV_FILE` overrides where the env file is written.

Re-running `enroll.js` mints a fresh token and revokes this machine's previous one, so
re-running an installer is safe and a token that leaked from this machine dies at its next
enrollment.

A hand-minted machine skips enrollment entirely and sets `CODEX_CRED_TOKEN` from
`add-client.js` directly.

Then pull. `pull.js` reads env vars, not the env file, so load it first:

```bash
set -a; . ~/.config/codex-credential.env; set +a
node ~/.local/share/claude-codex-gateway/client-agent/pull.js --force
```

It logs `installed` with the expiry and writes `~/.codex/auth.json` at mode 600. Without
`--force` it is a no-op while more than `CODEX_CRED_RENEW_BELOW_DAYS` (default 4) remain —
it logs `still_fresh` and exits 0 — so running it often is harmless.

The file it writes has `refresh_token` set to `""`. Both halves of that are load-bearing:
the field must be **present**, because codex fails to parse a file without it, and the
value must be **invalid**, because that is what makes the client structurally unable to
refresh and therefore unable to rotate the center's token away.

### Testing without overwriting your real credential

`pull.js` honours `CODEX_HOME` (default `~/.codex`), so point it at a scratch directory:

```bash
CODEX_HOME=/tmp/codex-probe node ~/.local/share/claude-codex-gateway/client-agent/pull.js --force
cat /tmp/codex-probe/auth.json
```

Nothing outside `/tmp/codex-probe` is touched. Use the same variable to run a real codex
turn against the fetched credential without disturbing your own login, and delete the
directory afterwards.

---

## 8. Keep it running

### The center: refresh on a timer

`refresh.js` refreshes only when fewer than `CODEX_CRED_REFRESH_THRESHOLD_DAYS` (default 3)
remain of the ~10-day access token; otherwise it republishes and exits. Refreshing less
often is strictly safer, because every refresh rotates the single-use token and every
rotation is a chance to lose it. Run it daily: that leaves several consecutive failures
worth of slack before any client notices.

`CODEX_CRED_ALERT_WEBHOOK` is optional but strongly advised. Alerts always go to stderr;
with a webhook configured they also reach somewhere you will actually look. A broken
refresh chain is invisible — clients keep working on the tokens they already hold and then
all fail at once, days later, far from the cause.

```bash
mkdir -p ~/.config/systemd/user
NODE="$(command -v node)"
CC="$HOME/claude-codex-gateway/codex-credential"

cat > ~/.config/systemd/user/codex-refresh.service <<EOF
[Unit]
Description=Codex credential refresh
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
Environment=CODEX_CRED_HOME=$CODEX_CRED_HOME
#Environment=CODEX_CRED_ALERT_WEBHOOK=https://example.invalid/hook
ExecStart=$NODE $CC/refresh-center/refresh.js
EOF

cat > ~/.config/systemd/user/codex-refresh.timer <<'EOF'
[Unit]
Description=Refresh the Codex credential daily

[Timer]
OnCalendar=daily
RandomizedDelaySec=30m
Persistent=true

[Install]
WantedBy=timers.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now codex-refresh.timer
systemctl --user start codex-refresh.service      # a fresh seed should take the no-refresh path
journalctl --user -u codex-refresh.service -n 20 --no-pager
```

### The center: supervise the dispenser

```bash
cat > ~/.config/systemd/user/codex-dispenser.service <<EOF
[Unit]
Description=Codex token dispenser
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
Environment=CODEX_CRED_HOME=$CODEX_CRED_HOME
Environment=CODEX_CRED_PORT=8443
ExecStart=$NODE $CC/token-dispenser/server.js
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
EOF

systemctl --user daemon-reload
systemctl --user enable --now codex-dispenser.service
systemctl --user status codex-dispenser.service --no-pager
```

User units stop when your last session ends. To keep the dispenser up across logout,
enable lingering for your account — `loginctl enable-linger "$USER"`, which on some systems
needs an administrator. If you cannot, run the dispenser under whatever supervisor you do
control; the only requirements are that it restarts on failure and that `CODEX_CRED_HOME`
is set in its environment.

### The client: pull on a timer

The repository ships templates in `client-agent/install/systemd/` with `NODE_PATH` and
`AGENT_PATH` as substitution markers. The service reads `~/.config/codex-credential.env` —
the file `enroll.js` already wrote — so the bearer token never appears in a unit file.

```bash
mkdir -p ~/.config/systemd/user
AGENT="$HOME/.local/share/claude-codex-gateway/client-agent"
sed -e "s|NODE_PATH|$(command -v node)|" -e "s|AGENT_PATH|$AGENT/pull.js|" \
  "$AGENT/install/systemd/codex-credential.service" \
  > ~/.config/systemd/user/codex-credential.service
cp "$AGENT/install/systemd/codex-credential.timer" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now codex-credential.timer
systemctl --user list-timers codex-credential.timer --no-pager
```

The shipped timer fires twice daily with an hour of jitter and `Persistent=true`, against a
client that renews below 4 days remaining. That is many chances to succeed before anything
breaks. Lingering applies here too if the machine must stay current while nobody is logged
in.

Cadence, end to end: the access token lives ~10 days, the center refreshes below 3 days
remaining, the client renews below 4. Each stage has slack for the one behind it.

---

## 9. Verify the deployment

| Check | Expect |
|---|---|
| `curl -sk https://<center-host>:8443/health` | `{"status":"ok"}` |
| `GET /credential` with no `Authorization` header | `401` |
| `GET /credential` with a revoked token | `401` |
| A client with a **wrong** `CODEX_CRED_CERT_PIN` | fails *before* the bearer token is sent — the dispenser logs no request at all |
| `grep refresh_token "$CODEX_CRED_HOME/public/current.json"` | no match; the published file has no such field |
| `POST /enroll` before `set-enrollment-key.js`, or with a wrong key | `403`, byte-identical in both cases |
| `POST /enroll` with the right key | a token that then works on `/credential` — and no credential in the response body |
| `stat -c '%a' ~/.codex/auth.json` on a client | `600` |
| `.tokens.refresh_token` in a client's `auth.json` | `""` — present and invalid, by design |
| A second `pull.js` with no `--force` | logs `still_fresh`, changes nothing |
| A real codex turn on a client | completes |

**`codex login status` is not on that list, and must not be used as a health check.** It
reports `Logged in using ChatGPT` for a garbage token: it parses the file, it does not
validate the credential. Relying on it means a dead credential reports healthy right up
until a worker dies mid-turn. Check the expiry instead:

```bash
node -e '
const fs = require("node:fs");
const path = (process.env.CODEX_HOME ?? `${process.env.HOME}/.codex`) + "/auth.json";
const jwt = JSON.parse(fs.readFileSync(path, "utf8")).tokens.access_token;
const claims = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8"));
console.log(new Date(claims.exp * 1000).toISOString(),
            ((claims.exp * 1000 - Date.now()) / 86400000).toFixed(2) + " days remaining");'
```

…or make a real call and read the status. `client-agent/install/diagnose.sh` bundles this
check with the environment, config, permission and reachability probes, and changes nothing.

---

## 10. Troubleshooting

**`server certificate does not match the pin — refusing to send credentials`.** The client
compares the server's certificate fingerprint before attaching anything secret, so a
mismatch costs you nothing but a failed run. The message prints both `expected` and `got`;
compare `got` against the output of the `openssl` recomputation in step 4. Either the
certificate was regenerated and clients still hold the old pin, or `CODEX_CRED_CERT_PIN` was
transcribed wrong, or something is terminating TLS between the client and the dispenser.
Fix the pin on the client — never work around it by disabling the check.

**`dispenser returned 401`.** The bearer token is not in `clients/clients.json`, or its
record is revoked. Check with `node token-dispenser/add-client.js --list` on the center and
look for `auth_failed` in the dispenser log. Re-run `enroll.js` on the client to mint a
fresh token, or mint one by hand and update `~/.config/codex-credential.env`. Note that
`pull.js` reads the environment, not that file: if you changed the file, reload it or
restart the timer.

**`403` on `/enroll`.** One message, three causes, deliberately indistinguishable to a
caller: enrollment was never configured, the key is wrong or stale, or enrollment is
disabled. All three are operator actions on the center, not something the client can fix.
Run `node token-dispenser/set-enrollment-key.js --status` there; `--generate` re-enables
and mints a new key, and machines already enrolled are unaffected.

**`503` from `/credential`.** The dispenser is up but has nothing valid to serve:
`public/current.json` is missing, malformed, or already expired. It refuses rather than
handing out a token it knows is dead, which is why the failure is diagnosable here instead
of mid-turn on a client. Run `refresh.js` on the center and read its output.

**HTTP 451 with body `{"message":"no_biscuit_no_service"}`.** This is codex telling you the
credential it used is not valid — expired, or never valid. It fails cleanly:
`auth.json` is left unchanged, so overwriting it is safe. Check the expiry with the decoder
in step 9, then `pull.js --force`. If the pull succeeds and the 451 persists, the credential
is not the problem — re-check the client's egress to `chatgpt.com/backend-api/`.

**A broken refresh chain.** Symptom: `refresh.js` alerts `critical`, and every client will
expire together within ~10 days. Previous credential generations are retained in
`$CODEX_CRED_HOME/secret/` for inspection. Recovery is a fresh human `codex login` on any
machine that can reach ChatGPT, followed by `seed.js` again on the center.

An ambiguous refresh — a timeout, a lost response, an unknown 4xx — leaves
`secret/refresh-in-flight.json` behind as a persistent quarantine marker, and scheduled runs
refuse to refresh while it exists. That is intentional. The single-use rotation means the
request may have succeeded upstream with the reply lost, in which case the stored token is
already spent and no retry can recover it. Re-seeding from a fresh login clears the marker
safely. **Do not delete it merely to force a retry.**

`secret/operation.lock` is a different marker: it serialises `seed.js` against `refresh.js`.
A lock whose owning process is provably gone is reclaimed automatically; a live one fails
closed. Inspect it before removing it by hand.

---

## 11. Where to go next

- [`codex-credential/DEPLOY.md`](codex-credential/DEPLOY.md) — the multi-user deployment:
  separate Unix identities for the refresh center and the dispenser, systemd hardening that
  makes `secret/` unreachable from the dispenser's mount namespace, and the operating
  procedures for rotating client tokens and certificates.
- [`codex-credential/README.md`](codex-credential/README.md) — the measured facts about
  codex-cli behaviour that constrain every part of this design, and the hard constraints for
  anyone modifying it.
- [`credential-console/`](credential-console/) — the multi-account side of this repository.
  It adds a control plane with per-device enrollment, encrypted Claude OAuth storage, and a
  credential-isolating Claude gateway, and can import a `codex-credential` home like the one
  you just built read-only — showing its expiry and active-client count without ever reading
  the Codex refresh token.
