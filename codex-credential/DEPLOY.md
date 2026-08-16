# Deploying codex-credential

Three pieces: two on one egress-capable server, one on every machine that runs Codex.

Prerequisites:

- a server that can reach `auth.openai.com` **directly**. Verify by posting a deliberately invalid refresh token to `https://auth.openai.com/oauth/token`: a **401** means the endpoint is reachable and evaluating the request, so this host can serve as the center. A `403`, or no response at all, means it cannot;
- Node ≥ 20 on that server (the codex CLI itself is **not** needed there);
- one `auth.json` for the subscription account. Either a human runs `codex login` on a machine
  that can reach ChatGPT and copies the file over, or an administrator authorizes the account
  from `credential-console` — see [Seeding from the console](#seeding-from-the-console) below.

Placeholders used below: `<server>` is the host you chose as the center, `<public-ip-or-host>`
is the address clients will connect to, and `<machine-name>` is the name you give one client.

## 1. The server

```bash
sudo groupadd --system codex-credential
sudo useradd --system --home /var/lib/codex-credential --gid codex-credential \
  --shell /usr/sbin/nologin codex-refresh
sudo useradd --system --home /var/lib/codex-credential --gid codex-credential \
  --shell /usr/sbin/nologin codex-dispenser
sudo install -d -o codex-refresh -g codex-credential -m 0750 /var/lib/codex-credential
sudo install -d -o codex-refresh -g codex-credential -m 0700 /var/lib/codex-credential/secret
sudo install -d -o codex-refresh -g codex-credential -m 0750 /var/lib/codex-credential/public
sudo install -d -o codex-dispenser -g codex-credential -m 0700 \
  /var/lib/codex-credential/{clients,tls}
sudo git clone https://github.com/Bazin-ga/claude-codex-gateway /opt/claude-codex-gateway
export CODEX_CRED_HOME=/var/lib/codex-credential
cd /opt/claude-codex-gateway/codex-credential
```

**Seed the credential.** This is the only moment a human is involved.

```bash
sudo -u codex-refresh CODEX_CRED_HOME=$CODEX_CRED_HOME \
  node refresh-center/seed.js /path/to/auth.json
```

> The source `auth.json` becomes stale at the first rotation. It is a seed, not a backup — the live credential lives in `$CODEX_CRED_HOME/secret/` from here on.

### Seeding from the console

`codex login` on another machine is no longer the only way to produce that `auth.json`.
`credential-console` can run the same ChatGPT authorization-code flow itself: register a Codex
account there, open its **Codex authorization** page, sign in, and paste back the localhost
address the browser fails to open. That console then either hands you the finished `auth.json`
to feed to the command above, or — when its `CREDENTIAL_CONSOLE_CODEX_SEED_HOME` points at this
home — writes it here directly, using this same store, expiry parser, and operation lock.

Console-side writing means the console's user needs write access to `$CODEX_CRED_HOME/secret/`,
which the read-only import path deliberately avoids. Grant it only if the console and this centre
are one trust domain; otherwise leave that variable unset and keep seeding by hand.

Whichever route produced it, do not re-seed a running centre from an old file: the first
rotation invalidated it, and overwriting the live credential with a spent token costs a fresh
authorization.

**Certificate and clients.**

```bash
sudo -u codex-dispenser CODEX_CRED_HOME=$CODEX_CRED_HOME \
  ./token-dispenser/gen-cert.sh <public-ip-or-host>   # note the pin it prints

sudo -u codex-dispenser CODEX_CRED_HOME=$CODEX_CRED_HOME \
  node token-dispenser/add-client.js workstation-1    # note the token it prints
```

Pass `gen-cert.sh` the address clients will actually dial, so the SAN matches; it emits
`IP:` for an IPv4 literal and `DNS:` otherwise. The pin the client checks is the SHA-256 of
the certificate itself, so regenerating the certificate invalidates every client's pin.
Machine names must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`.

Each token is shown **once** and only its digest is stored; re-issuing means revoking and minting again.

**Enrollment key** — optional, but it is what lets machines provision themselves instead of
queueing behind whoever holds this shell.

```bash
sudo -u codex-dispenser CODEX_CRED_HOME=$CODEX_CRED_HOME \
  node token-dispenser/set-enrollment-key.js --generate    # note the key it prints
```

Distribute that key to the machines that may enrol. It mints machine tokens and **cannot read
a credential**, so it can travel through a channel a credential could not — a secrets manager,
a configuration-management secret, an out-of-band message. Do not commit it to a repository: a
committed value survives in history after rotation. Rotate it on whatever schedule you use for
shared configuration values, and whenever someone who held it should no longer be able to enrol
new machines; rotation does not disturb machines already enrolled. Until this step is run,
`POST /enroll` answers `403` for every key, indistinguishably from a wrong one.

**Services.**

```bash
NODE_PATH="$(command -v node)"
sed "s|NODE_PATH|$NODE_PATH|g" refresh-center/install/codex-refresh.service |
  sudo tee /etc/systemd/system/codex-refresh.service >/dev/null
sudo cp refresh-center/install/codex-refresh.timer /etc/systemd/system/
sed "s|NODE_PATH|$NODE_PATH|g" token-dispenser/install/codex-dispenser.service |
  sudo tee /etc/systemd/system/codex-dispenser.service >/dev/null
# Configure alert delivery before systemd first loads the unit. This value is
# required: a broken refresh chain otherwise stays invisible until clients die.
export CODEX_CRED_ALERT_WEBHOOK=https://alerts.example.invalid/codex-credential
sudo install -d -m 0755 /etc/systemd/system/codex-refresh.service.d
printf '[Service]\nEnvironment=CODEX_CRED_ALERT_WEBHOOK=%s\n' "$CODEX_CRED_ALERT_WEBHOOK" |
  sudo tee /etc/systemd/system/codex-refresh.service.d/alert.conf >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now codex-refresh.timer codex-dispenser
# The fresh seed should take the no-refresh path and emit a test/info alert.
sudo systemctl start codex-refresh.service
sudo journalctl -u codex-refresh.service -n 20 --no-pager
```

Open the dispenser port (`CODEX_CRED_PORT`, default `8443`) in the firewall / security group.

The refresh center and dispenser deliberately use different Unix users. Only
`codex-refresh` can read `secret/`; `codex-dispenser` can read the group-published
access-token file but cannot traverse the refresh-token directory. The shipped dispenser unit
adds `InaccessiblePaths=/var/lib/codex-credential/secret` and mounts the rest of the data
directory read-only apart from `clients/`, which enrollment must write.

Confirm that the manual service run above reached the configured alert receiver
before relying on the timer. Without a working receiver, a broken refresh chain
stays invisible until every machine expires days later, all at once.

### Running it without root

Not every operator can create system users. Both components work in a single-user,
self-contained layout: point `CODEX_CRED_HOME` at a directory you own and run everything as
yourself.

```bash
export CODEX_CRED_HOME="$HOME/.local/share/codex-credential"
mkdir -p "$CODEX_CRED_HOME" && chmod 700 "$CODEX_CRED_HOME"
git clone https://github.com/Bazin-ga/claude-codex-gateway ~/claude-codex-gateway
cd ~/claude-codex-gateway/codex-credential

node refresh-center/seed.js /path/to/auth.json
./token-dispenser/gen-cert.sh <public-ip-or-host>
node token-dispenser/set-enrollment-key.js --generate
node token-dispenser/add-client.js <machine-name>
```

Every tool honours `CODEX_CRED_HOME` and creates the subdirectories it needs at the right
modes, so the `install -d` step above is not required here. Keep the listen port above 1024 —
the default `8443` already is.

Then run the two services as your user: `token-dispenser/server.js` continuously, and
`refresh-center/refresh.js` on a schedule (daily is right for a ~10-day token). A systemd
`--user` unit and timer work; so does any other supervisor plus `cron`. The shipped units
under `refresh-center/install/` and `token-dispenser/install/` are system units: to reuse them,
drop the `User=`/`Group=` lines, adjust `Environment=CODEX_CRED_HOME=`, `ReadWritePaths=`,
`InaccessiblePaths=` and the `ExecStart` path, and note that `ProtectHome=true` must go if the
data directory lives under your home. With `systemctl --user`, enable lingering
(`sudo loginctl enable-linger $USER`) or the timer stops when your last session ends.
`CODEX_CRED_ALERT_WEBHOOK` is as necessary here as in the root layout — set it in whatever
environment the refresh process gets.

**The trade-off, plainly.** With one Unix user, the refresh-center / dispenser privilege
separation described above is not enforced by the operating system. The dispenser process runs
as an identity that *can* read `secret/`, so if it were modified to read the refresh token, the
OS would not stop it. What still holds is the structural property of the published file: the
dispenser serves `public/current.json`, which is written from `access_token`, `id_token` and
`account_id` only and never contains a refresh token — so an unmodified dispenser has nothing
to leak. Choose this layout when you control what runs on the host; choose the two-user layout
when you want the kernel to enforce the boundary rather than the code.

## 2. Every client machine

The simplest path is the scripted installer — `client-agent/install/install.sh` on Linux and
macOS, `install/windows/install.ps1` on Windows. Each copies the agent, writes a mode-600 env
file, fetches a credential immediately, and registers a timer. See
[`client-agent/install/README.md`](client-agent/install/README.md).

If you also run [`../credential-console/`](../credential-console/), a member can open the
console, choose their operating system, and download a one-time, self-contained installer with
the agent, a newly minted per-device token, the dispenser endpoint, and the certificate pin
already embedded. Running that file does not require access to the console; only the dispenser
endpoint has to be reachable.

The manual workflow below is the same steps by hand.

```bash
mkdir -p ~/.local/share/claude-codex-gateway
cp -r /path/to/claude-codex-gateway/codex-credential/client-agent ~/.local/share/claude-codex-gateway/
```

**Self-service** — the machine mints its own token from the shared enrollment key, so nobody
has to hand it one:

```bash
export CODEX_CRED_ENDPOINT=https://<server>:8443
export CODEX_CRED_CERT_PIN=<pin from gen-cert.sh>
read -rs -p 'enrollment key: ' CODEX_CRED_ENROLLMENT_KEY; export CODEX_CRED_ENROLLMENT_KEY; echo

node ~/.local/share/claude-codex-gateway/client-agent/enroll.js   # writes ~/.config/codex-credential.env
```

**Hand-provisioned** — when a machine should be issued individually instead:

```bash
export CODEX_CRED_ENDPOINT=https://<server>:8443
export CODEX_CRED_CERT_PIN=<pin from gen-cert.sh>
read -rs -p 'machine token: ' CODEX_CRED_TOKEN; export CODEX_CRED_TOKEN; echo
```

The prompted read keeps the secret out of `~/.bash_history` — typing it as
`export CODEX_CRED_TOKEN=<value>` would leave it in a plaintext file that outlives the session.

Either way, then pull:

```bash
node ~/.local/share/claude-codex-gateway/client-agent/pull.js --force
```

`--force` replaces `$CODEX_HOME/auth.json` (default `~/.codex/auth.json`) unconditionally, and
keeps no backup. If this machine has a personal `codex login` you want to keep, copy that file
somewhere safe first, or rehearse against a scratch directory with `CODEX_HOME=/tmp/codex-probe`.

Do **not** verify with `codex login status` — it reports `Logged in` even for a garbage
token. Decode the access token's `exp`, or make a real call.

Then install the timer for the platform — `install/` has a systemd user timer, a macOS launchd agent, and a Windows scheduled-task script.

For Linux, persist the three values before enabling the user timer:

```bash
install -d -m 700 ~/.config ~/.config/systemd/user
install -m 600 /dev/null ~/.config/codex-credential.env
cat > ~/.config/codex-credential.env <<'EOF'
CODEX_CRED_ENDPOINT=https://<server>:8443
CODEX_CRED_TOKEN=<that machine's token>
CODEX_CRED_CERT_PIN=<pin from gen-cert.sh>
EOF
AGENT=~/.local/share/claude-codex-gateway/client-agent
sed -e "s|NODE_PATH|$(command -v node)|g" -e "s|AGENT_PATH|$AGENT/pull.js|g" \
  "$AGENT/install/systemd/codex-credential.service" \
  > ~/.config/systemd/user/codex-credential.service
cp "$AGENT/install/systemd/codex-credential.timer" ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now codex-credential.timer
```

A user timer only runs while the user has a session unless lingering is enabled
(`sudo loginctl enable-linger $USER`). On a headless host, skipping that means the timer
silently never fires again after you log out.

For macOS, use `install.sh`. The launchd plist is a template with `RUNNER_PATH` and `LOG_PATH`
placeholders, and `RUNNER_PATH` points at a `run.sh` wrapper the installer generates — launchd
has no `EnvironmentFile`, so the wrapper is what *exports* the mode-600 env file to the child
`node` process. Substituting the plist by hand without that wrapper produces an agent that
runs and finds no configuration.

**The client also needs its own egress to `chatgpt.com/backend-api/`** — the dispenser only supplies credentials, not connectivity. Note this is *not* `api.openai.com`: a subscription token has no API-platform scope there.

## Verifying a deployment

| Check | Expect |
|---|---|
| `curl -k https://<server>:8443/health` | `{"status":"ok"}` |
| Same, no `Authorization` header, on `/credential` | `401` |
| A client with a **wrong** `CODEX_CRED_CERT_PIN` | aborts *before* sending the token |
| `cat $CODEX_CRED_HOME/public/current.json` | no `refresh_token` field |
| `POST /enroll` with a wrong key, or before `set-enrollment-key.js` | `403`, identical in both cases |
| `POST /enroll` with the right key | a token that then works on `/credential` — and no credential in the body |
| `curl -s -o /dev/null -w "%{http_code}\n" https://chatgpt.com/backend-api/codex/responses` **on a client** | `405` — a GET on a POST-only route, i.e. the path is reachable. `000` means the client has no egress |
| A real codex turn on a client | completes |

Note what is **not** in that table: `codex login status`. It reports `Logged in using ChatGPT`
for a garbage token, so it can only tell you the file parses. A real turn is the check.

## Operating it

**Rotating a client's token** — `add-client.js --revoke <name>`, then mint a new one. The revoked token is refused at that machine's next pull.

**Rotating the certificate** — regenerate, then update `CODEX_CRED_CERT_PIN` on every client. Until you do, clients refuse to connect. That refusal is the pin working, not a fault.

**Recovering from a dead refresh chain** — authorize the account again, either with `codex login` on any machine that can reach ChatGPT or from the console's Codex authorization page, then re-seed. Previous credential generations are retained in `$CODEX_CRED_HOME/secret/` if you need to inspect what happened.

An ambiguous refresh leaves `secret/refresh-in-flight.json` as a persistent
quarantine marker. Scheduled runs refuse to refresh while it exists. Re-seeding
from a fresh human login clears it; do not delete it merely to force a retry.

**Never run `codex login` on the server.** It wipes the existing credential *before* waiting for authorization, so an interrupted login destroys it with no recovery. The server does not need the codex CLI at all.

## What was verified, and what was not

Verified end to end against a real credential (codex-cli 0.145.0):

- the distributed credential shape — `refresh_token` present but invalid — **runs a real turn** and leaves `auth.json` byte-identical, so a client can never rotate the center's token away;
- a real codex accepts the file the client-agent writes;
- the dispenser refuses unauthenticated, wrong-token, and expired-source requests, and its published file provably carries no refresh token;
- a wrong certificate pin aborts the client before the bearer token is transmitted;
- the client is idempotent, writes at mode 600, and fails closed and loudly.

Not yet verified:

- **the live OAuth refresh exchange.** Its request shape is confirmed (the endpoint answers `401 token_expired` to a deliberately invalid token, i.e. it parses and evaluates the request), but a successful rotation has not been performed — doing so consumes the current refresh token, so it happens on the first real run.
- **vendor-side sharing detection.** Three concurrent calls on one token all succeeded, but from a single host and IP. Whether many machines on one subscription draws attention is not something this repository can measure.
