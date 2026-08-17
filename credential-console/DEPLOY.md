# Deploying credential-console

The console is normally deployed on the same host as the Codex dispenser, so it can import that
credential home read-only over the local filesystem. That is a convenience, not a requirement: the
console runs on any host that can reach the dispenser over the network, and the read-only import is
simply unavailable when the Codex credential home is on a different machine.

`credential-console` requires Node 22.5 or newer because its body-free request metrics use the
built-in `node:sqlite` module. The shipped service suppresses Node 22's known experimental-module
warning; it does not suppress application errors.

P6 permanently stores the prompt and reply text for eligible captured conversation turns from Claude in the
conversation archive. Everyone who can reach the console can read those captured conversations; in
`open` mode that means anyone on the tailnet, with no identity and no reading audit. Member labels
are self-entered and unverified, and Codex traffic is not covered by conversation capture.

## Network

The recommended deployment separates a private control plane from public, token-authenticated
runtime data planes:

- join the host to a Tailscale network you control;
- publish the control-plane root with Tailscale Serve on port 443;
- publish only `/claude` with Tailscale Funnel on port 10000;
- keep the pinned Codex dispenser on its own public port, TCP 8443 by default;
- require members and administrators to join the tailnet to issue or revoke credentials, while
  enrolled runtime devices need only ordinary internet access.

The Node service itself binds only `127.0.0.1:9080`. Do not expose 9080.

## Filesystem and user

```bash
sudo useradd --system --home /var/lib/credential-console \
  --shell /usr/sbin/nologin credential-console
sudo install -d -o credential-console -g credential-console -m 0700 \
  /var/lib/credential-console
sudo install -d -o root -g root -m 0755 /var/www/letsencrypt
```

If importing a Codex credential home on the same host, grant read-only access to its public
credential metadata **and to `clients/`** through the systemd unit's
`SupplementaryGroups=codex-credential`. The shipped unit lists both under `ReadOnlyPaths=`.

`clients/clients.json` is the dispenser's machine registry, and it is the only record that a Codex
machine exists — those machines enrol against the dispenser and never contact the console. Without
read access the dashboard's machine inventory permanently shows
`Codex machines could not be read…` and lists no Codex machine at all. The dispenser still owns
every write to that file; the console reads it and drops `token_sha256` at the read boundary, so no
bearer digest reaches a rendered page. A `clients/` directory that does not exist yet is not an
error — it means no machine has enrolled — and produces no warning.

Do not grant access to `/var/lib/codex-credential/secret` unless you deliberately enable
console-side seeding, which requires exactly that and is described in
[Codex account authorization](#codex-account-authorization).

Initialize the encryption key before any other console command on a genuine first deployment:

```bash
sudo -u credential-console \
  CREDENTIAL_CONSOLE_HOME=/var/lib/credential-console \
  node /opt/claude-codex-gateway/credential-console/cli.js init-key
```

`master.key` encrypts every stored Claude OAuth credential. The store refuses to start when the
key is absent; it does not generate a replacement. `init-key` creates it only when absent and
refuses to overwrite an existing key. Losing this key makes every stored Claude OAuth
credential unrecoverable; each account owner would have to complete the owner-authorization
page again. Back it up as described in
[Backup, restore, and rollback](#backup-restore-and-rollback) before adding Claude accounts.

## Service

Install the unit before any later command stops or starts the service:

```bash
sudo -u credential-console /usr/bin/env node -e \
  'const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || (major === 22 && minor < 5)) process.exit(1)'
sudo install -m 0644 install/credential-console.service \
  /etc/systemd/system/credential-console.service
sudo systemctl daemon-reload
sudo systemctl enable --now credential-console
curl -fsS http://127.0.0.1:9080/health
```

## Administrator authentication

There are two modes and the console has no login of its own in either. `tailscale` takes the
administrator's identity from Tailscale; `open` identifies nobody. `CREDENTIAL_CONSOLE_ADMIN_AUTH`
defaults to `tailscale`, so a deployment that never sets it fails closed and refuses requests
that carry no tailnet identity. `open` has to be chosen on purpose.

For a tailnet-only deployment, use Tailscale identity:

```bash
sudo sh -c 'umask 077; printf "%s\n" \
  "CREDENTIAL_CONSOLE_PUBLIC_URL=https://<console-host>.<your-tailnet>.ts.net" \
  "CREDENTIAL_CONSOLE_CLAUDE_GATEWAY_URL=https://<console-host>.<your-tailnet>.ts.net:10000/claude" \
  "CREDENTIAL_CONSOLE_ADMIN_AUTH=tailscale" \
  "CREDENTIAL_CONSOLE_USAGE_REFRESH_INTERVAL_MS=3600000" \
  > /etc/credential-console.env'
```

Every user-owned tailnet device that policy allows to reach this Serve endpoint becomes an
administrator. Tailscale Serve removes spoofed identity headers and supplies
`Tailscale-User-Login`; the Node service must remain loopback-only. Tagged devices do not
receive a user identity header and cannot administer the console in this mode.

For a deployment where the surrounding private network is already the access-control decision,
`CREDENTIAL_CONSOLE_ADMIN_AUTH=open` removes console authentication entirely:

```bash
sudo sh -c 'umask 077; printf "%s\n" \
  "CREDENTIAL_CONSOLE_PUBLIC_URL=https://<console-host>" \
  "CREDENTIAL_CONSOLE_CLAUDE_GATEWAY_URL=https://<console-host>:10000/claude" \
  "CREDENTIAL_CONSOLE_ADMIN_AUTH=open" \
  > /etc/credential-console.env'
```

There is no identity of any kind. Every client that can open the console can add accounts, issue
device credentials, and revoke them, and the audit log records only self-asserted member labels.
With nothing to bind a flow to, one visitor can also complete a Claude or Codex authorization
session that another visitor started; PKCE, the single live session, and the 15-minute expiry are
the only limits left on that step.
Reachability is the whole authorization boundary, so keep the listener on a private overlay
network you control and never expose it through Funnel or a public reverse proxy. The service
still binds only `127.0.0.1:9080` in this mode, so follow [Tailscale](#tailscale) to publish it
— Serve works unchanged with `open` and keeps the loopback bind — and set the mode to `open` in
the file that section rewrites. Per-session
CSRF tokens still apply, so a visitor's browser cannot be driven by another site. Every page
carries a banner stating that the console is unauthenticated, and `/health` reports
`admin_configured: false` for as long as the mode is set — alert on it if you did not intend it.

The dashboard also shows a **Copy guide link** button for the tailnet-internal live AI guide. The
link ends in `/onboarding.md`; it follows the same reachability/identity and session logic as the
console and returns Markdown, not HTML. Tailscale mode requires a tailnet identity; an open-mode GET
may create an anonymous session. In `open` mode, anyone who can reach this private console can read
the guide's current deployment and account metadata, so the same private-network restriction
applies to this guide.
The public repository's `AI-ONBOARDING.md` is only the generic, address-free edition and is not a
replacement for this live link. A human must explicitly authorize any local execution of a
secret-bearing generated installer; after authorization an AI may run it locally, but must never
paste the installer or its output into the conversation.

There is no third mode and nothing to bootstrap: the console has no administrator credential, so
neither deployment needs a password file or a setup command. Confirm the mode a running service
actually resolved before exposing it:

```bash
curl -fsS http://127.0.0.1:9080/health
# {"status":"ok","admin_auth":"tailscale","client_config_version":"1","admin_configured":true}
```

Import a Codex credential home read-only. Stop the service before running this mutating command,
then start it again afterward:

```bash
sudo systemctl stop credential-console
sudo -u credential-console \
  CREDENTIAL_CONSOLE_HOME=/var/lib/credential-console \
  node /opt/claude-codex-gateway/credential-console/cli.js \
  import-codex --alias codex-shared-1 --home /var/lib/codex-credential
sudo systemctl start credential-console
curl -fsS http://127.0.0.1:9080/health
```

The server holds a single-writer lock on the credential home for its lifetime. The `init-key` and
`import-codex` commands acquire the same lock and fail fast while the service is running. Stop the
service before running either of them. `list` is read-only and does not acquire the lock.

The dashboard reads the imported home's `public/current.json` and, when available,
`public/health.json` as untrusted read-only metadata. A current snapshot is valid only with
nonempty `access_token` and `account_id` fields plus a parseable `expires_at`; those values are
used for validation only and are never rendered. Missing/unreadable current metadata is classified
as unavailable, malformed metadata as invalid, and an expired timestamp as expired. A valid
current expiry is authoritative over a stale health expiry. Version-1 health fields are
sanitized to fixed timestamps/outcomes/classes and booleans: raw failures, paths, tokens, and
account ids never reach HTML. Missing, malformed, or stale health is a warning; refresh failure,
quarantine, persist/publish/unreadable outcomes, and cycles stuck beyond 15 minutes are critical.
Staleness is `expected_interval_seconds × 2.5`, clamped to 15 minutes–7 days, with a 36-hour
fallback. Codex warns at 3 days and is critical at 24 hours/expired; Claude warns at 7 days and
is critical at 24 hours/expired. Login-required and pending rows remain neutral. The first-screen
summary shows at most three alerts, while account rows show relative expiry, the last successful
credential check, and last rotation.

## Codex account authorization

The console can run the ChatGPT subscription login itself, so no `codex login` on a separate
machine and no hand-carried `auth.json` is needed to get a Codex credential into the refresh
centre. Register the account in the dashboard ("Add a Codex team account"), open its **Codex
authorization** page, and follow it. The browser's final hop to `http://localhost:1455` fails by
design — that is where the authorization code appears, and the page says so.

Decide first where the finished credential should land.

**Default — the console writes nothing.** Leave `CREDENTIAL_CONSOLE_CODEX_SEED_HOME` unset. The
`auth.json` is rendered once with copy and download buttons, and the page prints the exact seed
command to run on the refresh centre:

```bash
sudo -u codex-refresh CODEX_CRED_HOME=/var/lib/codex-credential \
  node /opt/claude-codex-gateway/codex-credential/refresh-center/seed.js ./codex-auth-<alias>.json
shred -u ./codex-auth-<alias>.json
```

Leaving or reloading the page hides the credential permanently; there is no second render. This
preserves the read-only import boundary above: the console never touches
`/var/lib/codex-credential/secret`.

**Opt-in — the console seeds the home directly.** This needs three changes, not one. The shipped
unit deliberately walls the console off from that home, so the variable alone does nothing but
produce a refusal.

1. Add to `/etc/credential-console.env`:

   ```dotenv
   CREDENTIAL_CONSOLE_CODEX_SEED_HOME=/var/lib/codex-credential
   ```

2. Undo the unit's own hardening for that path, with
   `sudo systemctl edit credential-console`. A systemd mount namespace cannot be reopened by a
   filesystem ACL, so this is not optional:

   ```ini
   [Service]
   # Both lists are additive; the empty assignment resets the shipped value first.
   InaccessiblePaths=
   ReadOnlyPaths=
   # Keep clients/ readable, or the dashboard loses every Codex machine.
   ReadOnlyPaths=/var/lib/codex-credential/clients
   ReadWritePaths=/var/lib/codex-credential/secret /var/lib/codex-credential/public
   ```

3. Grant the access on the **directories**, not on `current.json`. Every write here is
   temp-file-plus-rename, so the publish creates `current.json.<hex>.tmp` as a sibling and needs
   write and execute on `public/` itself:

   ```bash
   sudo setfacl -m u:credential-console:rwx /var/lib/codex-credential/secret
   sudo setfacl -m u:credential-console:rwx /var/lib/codex-credential/public
   ```

A completed authorization is then written by the console using the refresh centre's own store:
same atomic write, same retained generations, same `public/` publish, same operation lock. If the
lock is held by a running refresh, the console refuses with `is busy, so nothing was written`
instead of racing it; retry once the refresh timer is idle. One variable means one home, and one
home holds one credential: an authorization for a second Codex account that would overwrite the
first account's credential is refused before it starts.

**Start authorization** probes the home for writability before it opens a session, so a missed
step above is reported as `is not writable by this console (EACCES)` while nothing has been spent.
Verify it once after the changes: press **Start a fresh authorization** and expect the OpenAI
link rather than that message.

> This **contradicts the read-only rule stated under
> [Filesystem and user](#filesystem-and-user)**. The console's user now needs write access to
> `/var/lib/codex-credential/secret`, so a console compromise reaches the Codex refresh token
> that read-only import was designed to keep away from it. Enable it only where the console and
> the refresh centre are already one trust domain.
>
> The dispenser's client-token registry stays out of reach either way.

In both cases the seed is a handover, not a backup. OpenAI rotates refresh tokens single-use, so
the centre's first rotation kills the credential produced here. A downloaded `auth.json` is dead
from that moment: delete it, never archive it, and never re-seed a running centre from an old
copy — that overwrites the live credential with a spent one and costs a fresh authorization.

Verify the seed the way `codex-credential/DEPLOY.md` prescribes — never with `codex login status`,
which reports success for a garbage token:

```bash
sudo -u codex-refresh jq 'has("refresh_token"), .expires_at' \
  /var/lib/codex-credential/public/current.json
```

Expect `false` and a future timestamp, then confirm with a real turn from an enrolled client.

## Codex member self-service

The console can exchange a server-held, mint-only enrollment key for a per-device dispenser
token. Members never receive the enrollment key. Rotating this key does not affect devices that
are already enrolled.

Let the dispenser generate the key. It prints the plaintext once and stores only its digest:

```bash
sudo -u codex-dispenser \
  CODEX_CRED_HOME=/var/lib/codex-credential \
  node /opt/claude-codex-gateway/codex-credential/token-dispenser/set-enrollment-key.js \
  --generate
```

Write the printed key into the file the console reads, without putting it on a command line:

```bash
sudo install -o root -g credential-console -m 0640 /dev/null \
  /etc/credential-console-codex-enrollment-key
sudo sh -c 'cat > /etc/credential-console-codex-enrollment-key'   # paste the key, then Ctrl-D
```

Do not pass the key with `--set` on the command line. Command arguments are readable by every
local user through `ps` for as long as the process runs, and the invocation is recorded in
shell history.

Calculate the current dispenser certificate pin:

```bash
openssl x509 -in /var/lib/codex-credential/tls/server.crt -outform DER \
  | openssl dgst -sha256 -hex
```

Add these values to `/etc/credential-console.env`:

```dotenv
CREDENTIAL_CONSOLE_CODEX_ENDPOINT=https://<server-public-ip>:8443
CREDENTIAL_CONSOLE_CODEX_CERT_PIN=<sha256-hex>
CREDENTIAL_CONSOLE_CODEX_ENROLLMENT_KEY_FILE=/etc/credential-console-codex-enrollment-key
```

The dispenser remains on its existing public port. The console calls `/enroll` server-side;
generated self-contained installers call `/credential` over the public internet using the same
certificate pin. They carry only their per-device token and do not fetch source files from the
private console.

## Tailscale

Install Tailscale from its official repository, then join your tailnet with a stable
hostname:

```bash
sudo tailscale up --hostname <console-host>
```

For unattended provisioning, use a tagged, reusable auth key with the smallest practical
ACL scope. Disable key expiry for the server node in the Tailscale admin console, or use
tag ownership to manage its lifecycle.

Enable tailnet HTTPS and publish the service:

```bash
sudo tailscale serve --bg http://127.0.0.1:9080
sudo tailscale serve status
```

Publish only the token-authenticated Claude runtime gateway and its self-only machine control API
on the separate public Funnel port:

```bash
sudo tailscale funnel --bg --https=10000 --set-path=/claude http://127.0.0.1:9080/claude
sudo tailscale funnel status
```

The `/claude` suffix on both sides is intentional. `--set-path` strips the public mount
prefix before proxying; adding it to the target preserves the path expected by the
credential console (`/claude/v1/...`).

The same mount intentionally includes two device-token-authenticated control endpoints:

```text
GET  https://<console-host>.<your-tailnet>.ts.net:10000/claude/control/v1/status
POST https://<console-host>.<your-tailnet>.ts.net:10000/claude/control/v1/account
     Authorization: Bearer <device-token>
     Content-Type: application/json
     {"account_id":"<allowed-account-id>"}
```

They derive the device exclusively from its existing token, check revocation on every call and
cannot read or modify any other device. There is no control-API enroll route; first-time issuance
stays on the tailnet-only console page. The account selector in that page remains CSRF-protected;
the bearer-token API does not use console cookies or CSRF.

Port 443 remains Serve-only and private. Port 10000 is Funnel-only and public, with only the
`/claude` mount configured; Funnel traffic does not carry Tailscale identity headers. Never
configure Funnel at `/` or on port 443 for this service.

Tailscale reports a URL such as
`https://<console-host>.<your-tailnet>.ts.net`. Put that exact origin and the chosen
administrator-auth mode in `/etc/credential-console.env`, restart `credential-console`,
and verify the generated enrollment links use it.

Serve keeps the loopback bind, so this step is the same for both administrator-auth modes and
an `open` deployment needs it too — the shipped unit binds `127.0.0.1:9080` and the server
refuses a non-loopback bind without TLS, so Serve (or your own proxy, under the constraints in
[Do not publish the complete console](#do-not-publish-the-complete-console)) is what makes the
console reachable at all.

This command rewrites the file, so it resets every variable it does not list. Substitute the
mode you chose in [Administrator authentication](#administrator-authentication) — an `open`
deployment must write `open` here, or this step silently puts it back into `tailscale`. If you
already added the `CREDENTIAL_CONSOLE_CODEX_*` lines from
[Codex member self-service](#codex-member-self-service), re-add them afterwards and restart the
service again — the console fails closed and simply hides Codex self-service when any of the
three is missing.

```bash
sudo sh -c 'umask 077; printf "%s\n" \
  "CREDENTIAL_CONSOLE_PUBLIC_URL=https://<console-host>.<your-tailnet>.ts.net" \
  "CREDENTIAL_CONSOLE_CLAUDE_GATEWAY_URL=https://<console-host>.<your-tailnet>.ts.net:10000/claude" \
  "CREDENTIAL_CONSOLE_ADMIN_AUTH=<tailscale-or-open>" \
  "CREDENTIAL_CONSOLE_USAGE_REFRESH_INTERVAL_MS=3600000" \
  > /etc/credential-console.env'
sudo systemctl restart credential-console
```

Confirm the mode the service actually resolved afterwards with
`curl -fsS http://127.0.0.1:9080/health`.

Tailnet policy should restrict access to the intended member group and this host. In
Tailscale administrator-auth mode, that policy is the administrator authorization boundary.

### Cloud VPC DNS resolvers that overlap the tailnet range

Some cloud VPC resolvers are addressed inside `100.64.0.0/10`, which overlaps the range
Tailscale uses for tailnet addresses. Check your provider's documented resolver addresses
against that range before assuming the tailnet is at fault. Replies from such a resolver
arrive on the physical interface with a source
address that Tailscale's anti-spoofing rules can reject, so name resolution stops working
even though the tailnet itself is up. The symptom is a working tailnet connection but a
Tailscale Serve TLS handshake that stalls while ACME DNS lookups time out.

On a host that does not require private VPC DNS names, configure resolvers outside
`100.64.0.0/10` on the active NetworkManager connection and leave tailnet DNS disabled on
that host. Substitute the resolvers you intend to use and the interface name of the host:

```bash
connection=$(nmcli -t -f NAME,DEVICE connection show --active \
  | awk -F: '$2=="eth0" {print $1; exit}')
sudo nmcli connection modify "$connection" \
  ipv4.ignore-auto-dns yes \
  ipv4.dns "<public-resolver-1> <public-resolver-2>"
sudo nmcli device reapply eth0
sudo tailscale set --accept-dns=false
```

Do not apply this workaround to hosts that depend on private VPC DNS zones. For those
hosts, use an explicit route/firewall design that permits the exact VPC resolvers instead.

## Do not publish the complete console

Public access is intentionally limited to the Claude gateway Funnel mount and the Codex
dispenser. Account enrollment, device issuance, revocation, and installer generation stay
tailnet-only.

Do not put a general-purpose reverse proxy in front of the loopback listener to publish the
whole console. In `CREDENTIAL_CONSOLE_ADMIN_AUTH=tailscale` mode the server accepts the
`Tailscale-User-Login` header from any peer on loopback and mints an administrator session
from it, because Tailscale Serve is what strips a spoofed copy of that header. A reverse proxy
is always a loopback peer, so unless it clears the header itself, any client that sends
`Tailscale-User-Login` becomes an administrator. `X-Forwarded-For` is trusted from loopback in
the same way and keys the public gateway's failed-authentication limiter.

`CREDENTIAL_CONSOLE_ADMIN_AUTH=open` has no header to spoof because it checks nothing; publishing
that listener publishes credential issuance and revocation to whoever reaches it.

If you nevertheless terminate TLS with your own proxy, mount only `/claude`, and clear both
headers on the way in — with nginx, `proxy_set_header Tailscale-User-Login "";` and
`proxy_set_header X-Forwarded-For "";` inside that location block.

## Backup, restore, and rollback

Treat `master.key` and `state.json` as one recovery unit. A key from one backup combined with
ciphertext from another decrypts nothing. `usage.json` is a regenerable quota cache and is not
critical to recovery. `metrics.sqlite` is the non-regenerable request-metadata and permanently
retained conversation history. Treat that database and every backup copy as sensitive conversation
content. Include both optional files in a point-in-time backup when they exist, and checkpoint the
metrics WAL after stopping the service before copying the database.

### Create and transfer a backup

1. Stop the service briefly, checkpoint and integrity-check the metrics database when present,
   then create a root-only snapshot. Replace
   `<backup-id>` with a unique UTC timestamp or change identifier:

```bash
set -euo pipefail
backup_id='<backup-id>'
console_home=/var/lib/credential-console
snapshot_dir=/var/backups/credential-console/snapshots/$backup_id
service_was_running=0
restart_on_exit() {
  status=$?
  trap - EXIT
  if [ "$service_was_running" -eq 1 ]; then
    if ! sudo systemctl start credential-console; then status=1; fi
  fi
  exit "$status"
}
trap restart_on_exit EXIT
if sudo systemctl is-active --quiet credential-console; then service_was_running=1; fi
sudo systemctl stop credential-console
sudo install -d -o root -g root -m 0700 "$snapshot_dir"
files=(master.key state.json)
if sudo test -f "$console_home/usage.json"; then
  files+=(usage.json)
fi
if sudo test -f "$console_home/metrics.sqlite"; then
  sudo -u credential-console env CREDENTIAL_CONSOLE_HOME="$console_home" \
    node --no-warnings /opt/claude-codex-gateway/credential-console/cli.js checkpoint-metrics
  files+=(metrics.sqlite)
fi
for file in "${files[@]}"; do
  sudo install -o root -g root -m 0600 "$console_home/$file" "$snapshot_dir/$file"
done
(cd "$snapshot_dir" && sudo sha256sum "${files[@]}") \
  | sudo tee "$snapshot_dir/SHA256SUMS" >/dev/null
sudo chmod 0600 "$snapshot_dir/SHA256SUMS"
(cd "$snapshot_dir" && sudo sha256sum --check SHA256SUMS)
if [ "$service_was_running" -eq 1 ]; then
  sudo systemctl start credential-console
  service_was_running=0
  curl -fsS http://127.0.0.1:9080/health
fi
trap - EXIT
```

2. Copy the complete snapshot directory off the host into a root-only destination. A same-host
   backup does not survive loss of the host. Use an encrypted transfer mechanism you trust;
   for example, from the backup host:

```bash
set -euo pipefail
backup_id='<backup-id>'
off_host_dir=/srv/secure-backups/credential-console/$backup_id
sudo install -d -o root -g root -m 0700 "$off_host_dir"
sudo rsync -a --chmod=F600,D700 \
  "backup-user@<console-host>:/var/backups/credential-console/snapshots/$backup_id/" \
  "$off_host_dir"/
(cd "$off_host_dir" && sudo sha256sum --check SHA256SUMS)
```

`state.json` changes continuously while the service runs because proxy traffic updates device
last-seen timestamps. A backup copy will therefore never hash-match the current live file after
the service restarts. Verify the transferred files against `SHA256SUMS` in the snapshot they came
from, not against the live file; a live-file mismatch does not mean the transfer was corrupt.

### Verify that the backup restores

1. On a secured verification host with the same application version, point `CredentialStore` at
   a private copy of the backup and decrypt every stored Claude credential:

```bash
set -euo pipefail
backup_id='<backup-id>'
verify_dir=/var/tmp/credential-console-restore-$backup_id
sudo install -d -o root -g root -m 0700 "$verify_dir"
sudo install -o root -g root -m 0600 \
  /srv/secure-backups/credential-console/"$backup_id"/{master.key,state.json} \
  "$verify_dir"/
if sudo test -f /srv/secure-backups/credential-console/"$backup_id"/usage.json; then
  sudo install -o root -g root -m 0600 \
    /srv/secure-backups/credential-console/"$backup_id"/usage.json "$verify_dir"/
fi
if sudo test -f /srv/secure-backups/credential-console/"$backup_id"/metrics.sqlite; then
  sudo install -o root -g root -m 0600 \
    /srv/secure-backups/credential-console/"$backup_id"/metrics.sqlite "$verify_dir"/
  sudo env CREDENTIAL_CONSOLE_HOME="$verify_dir" \
    node --no-warnings /opt/claude-codex-gateway/credential-console/cli.js checkpoint-metrics
fi
sudo env VERIFY_DIR="$verify_dir" \
  STORE_MODULE=/opt/claude-codex-gateway/credential-console/lib/store.js \
  node --input-type=module <<'NODE'
import { pathToFileURL } from 'node:url';

const { CredentialStore } = await import(pathToFileURL(process.env.STORE_MODULE));
const store = await new CredentialStore(process.env.VERIFY_DIR).init();
const accounts = store.publicAccounts().filter((account) => account.provider === 'claude');
if (accounts.length === 0) throw new Error('backup contains no Claude accounts');
for (const account of accounts) {
  const credential = store.accountCredential(account.id);
  if (!credential?.oauth_token) throw new Error(`credential unavailable for ${account.alias}`);
}
console.log(`decrypted ${accounts.length} Claude credential(s)`);
NODE
```

2. Run a negative control against another copy with a random key. This proves that the positive
   check actually reaches authenticated decryption and refuses the credential when the key is
   wrong. The script emits a machine-checkable outcome only for that expected refusal; successful
   decryption or any unrelated probe failure fails verification:

```bash
set -euo pipefail
negative_dir=${verify_dir}-negative
sudo install -d -o root -g root -m 0700 "$negative_dir"
sudo install -o root -g root -m 0600 "$verify_dir/state.json" "$negative_dir/state.json"
openssl rand -base64 32 | sudo tee "$negative_dir/master.key" >/dev/null
sudo chmod 0600 "$negative_dir/master.key"
set +e
negative_output=$(sudo env VERIFY_DIR="$negative_dir" \
  STORE_MODULE=/opt/claude-codex-gateway/credential-console/lib/store.js \
  node --input-type=module <<'NODE'
import { pathToFileURL } from 'node:url';

const { CredentialStore } = await import(pathToFileURL(process.env.STORE_MODULE));
const store = await new CredentialStore(process.env.VERIFY_DIR).init();
const account = store.publicAccounts().find((entry) => entry.provider === 'claude');
if (!account) throw new Error('backup contains no Claude accounts');
try {
  store.accountCredential(account.id);
} catch {
  console.log('NEGATIVE_CONTROL_AUTHENTICATED_DECRYPTION_REFUSED');
  process.exit(42);
}
NODE
)
negative_status=$?
set -e
if [ "$negative_status" -eq 0 ]; then
  echo 'ERROR: random key decrypted a credential' >&2
  exit 1
elif [ "$negative_status" -eq 42 ] \
  && [ "$negative_output" = 'NEGATIVE_CONTROL_AUTHENTICATED_DECRYPTION_REFUSED' ]; then
  echo 'expected failure: random key cannot decrypt the credential'
else
  printf '%s\n' "$negative_output" >&2
  echo 'ERROR: negative-control probe failed before producing the expected outcome' >&2
  exit 1
fi
```

Remove both verification directories after recording the result wherever you track backup
verifications.

### Restore or roll back

1. Select a backup that passed both verification controls. Stop the service and preserve a local
   rollback snapshot of the current matched pair:

If `master.key` is missing but the home contains encrypted data, do not run `init-key`. It exits
non-zero without writing a key and reports: `credential home already contains data encrypted under
a different key; a new key cannot decrypt it; restore master.key from backup instead`. Restore the
original matched key from backup.

```bash
set -euo pipefail
backup_id='<verified-backup-id>'
restore_source=/srv/secure-backups/credential-console/$backup_id
rollback_id=$(date -u +%Y%m%dT%H%M%SZ)
rollback_dir=/var/backups/credential-console/pre-restore-$rollback_id
restore_restart_pending=0
restart_restore_on_exit() {
  status=$?
  trap - EXIT
  if [ "$restore_restart_pending" -eq 1 ]; then
    if ! sudo systemctl start credential-console; then status=1; fi
  fi
  exit "$status"
}
trap restart_restore_on_exit EXIT
sudo systemctl stop credential-console
restore_restart_pending=1
sudo install -d -o root -g root -m 0700 "$rollback_dir"
sudo install -o root -g root -m 0600 \
  /var/lib/credential-console/{master.key,state.json} "$rollback_dir"/
if sudo test -f /var/lib/credential-console/usage.json; then
  sudo install -o root -g root -m 0600 \
    /var/lib/credential-console/usage.json "$rollback_dir"/
fi
if sudo test -f /var/lib/credential-console/metrics.sqlite; then
  sudo -u credential-console env CREDENTIAL_CONSOLE_HOME=/var/lib/credential-console \
    node --no-warnings /opt/claude-codex-gateway/credential-console/cli.js checkpoint-metrics
  sudo install -o root -g root -m 0600 \
    /var/lib/credential-console/metrics.sqlite "$rollback_dir"/
fi
```

2. Restore `master.key` and `state.json` as the matched pair from that single backup. Restore
   `usage.json` and `metrics.sqlite` when available. Remove stale SQLite sidecars before checking
   the restored database and starting the service:

```bash
set -euo pipefail
sudo install -o credential-console -g credential-console -m 0600 \
  "$restore_source/master.key" /var/lib/credential-console/master.key
sudo install -o credential-console -g credential-console -m 0600 \
  "$restore_source/state.json" /var/lib/credential-console/state.json
if sudo test -f "$restore_source/usage.json"; then
  sudo install -o credential-console -g credential-console -m 0600 \
    "$restore_source/usage.json" /var/lib/credential-console/usage.json
fi
if sudo test -f "$restore_source/metrics.sqlite"; then
  sudo install -o credential-console -g credential-console -m 0600 \
    "$restore_source/metrics.sqlite" /var/lib/credential-console/metrics.sqlite
  sudo rm -f /var/lib/credential-console/metrics.sqlite-wal \
    /var/lib/credential-console/metrics.sqlite-shm
  sudo -u credential-console env CREDENTIAL_CONSOLE_HOME=/var/lib/credential-console \
    node --no-warnings /opt/claude-codex-gateway/credential-console/cli.js checkpoint-metrics
else
  sudo rm -f /var/lib/credential-console/metrics.sqlite \
    /var/lib/credential-console/metrics.sqlite-wal \
    /var/lib/credential-console/metrics.sqlite-shm
fi
sudo systemctl start credential-console
curl -fsS http://127.0.0.1:9080/health
restore_restart_pending=0
trap - EXIT
```

3. If health or functional checks fail, roll back to the pre-restore matched pair:

```bash
set -euo pipefail
rollback_restart_pending=0
restart_rollback_on_exit() {
  status=$?
  trap - EXIT
  if [ "$rollback_restart_pending" -eq 1 ]; then
    if ! sudo systemctl start credential-console; then status=1; fi
  fi
  exit "$status"
}
trap restart_rollback_on_exit EXIT
sudo systemctl stop credential-console
rollback_restart_pending=1
sudo install -o credential-console -g credential-console -m 0600 \
  "$rollback_dir/master.key" /var/lib/credential-console/master.key
sudo install -o credential-console -g credential-console -m 0600 \
  "$rollback_dir/state.json" /var/lib/credential-console/state.json
if sudo test -f "$rollback_dir/usage.json"; then
  sudo install -o credential-console -g credential-console -m 0600 \
    "$rollback_dir/usage.json" /var/lib/credential-console/usage.json
fi
if sudo test -f "$rollback_dir/metrics.sqlite"; then
  sudo install -o credential-console -g credential-console -m 0600 \
    "$rollback_dir/metrics.sqlite" /var/lib/credential-console/metrics.sqlite
  sudo rm -f /var/lib/credential-console/metrics.sqlite-wal \
    /var/lib/credential-console/metrics.sqlite-shm
  sudo -u credential-console env CREDENTIAL_CONSOLE_HOME=/var/lib/credential-console \
    node --no-warnings /opt/claude-codex-gateway/credential-console/cli.js checkpoint-metrics
else
  sudo rm -f /var/lib/credential-console/metrics.sqlite \
    /var/lib/credential-console/metrics.sqlite-wal \
    /var/lib/credential-console/metrics.sqlite-shm
fi
sudo systemctl start credential-console
curl -fsS http://127.0.0.1:9080/health
rollback_restart_pending=0
trap - EXIT
```

## Verification

```bash
curl -fsS https://<console-host>.<your-tailnet>.ts.net/health
curl -i https://<console-host>.<your-tailnet>.ts.net:10000/claude/v1/models
curl -k https://<server-public-ip>:8443/health
sudo tailscale serve status
sudo tailscale funnel status
sudo systemctl status credential-console --no-pager
sudo journalctl -u credential-console -n 50 --no-pager
```

Browser checks:

1. open the dashboard from a user-owned tailnet device and confirm English is the default;
2. switch to Chinese, reload, and confirm the preference persists;
3. add a dummy Claude account only in a non-production test instance, open its permanent owner
   page, and confirm starting again replaces the previous 15-minute authorization session;
4. complete a test authorization and then choose that account in the self-service card to issue
   a device configuration;
5. confirm the configuration contains a per-device console token but not the provider token;
6. enroll one Codex device and confirm the result page offers downloadable macOS, Linux, and
   Windows installers with the same per-device token;
7. inspect the Codex installer and confirm it is self-contained and uses the public dispenser;
8. from a device outside the tailnet, confirm `/claude/v1/models` answers 401 without a
   device token and the Funnel root is not exposed;
9. optionally generate a Claude enrollment link and redeem it once;
10. confirm enrollment replay returns HTTP 410;
11. revoke the device and confirm its next gateway request returns HTTP 401.
12. confirm Codex quota data appears after the first refresh; if an account is marked as
    needing reauthorization, complete its permanent owner-authorization page once and confirm
    the five-hour and weekly windows appear without re-enrolling any member device.
13. from the dashboard's Administrator area, copy the `/onboarding.md` link, open it through the
    same private console session, and confirm the response is Markdown with current account
    metadata but no provider credential, device token, digest, or audit data;
14. confirm the live guide reports the client configuration version and compares stamps by exact
    equality; a missing stamp reports absent, while a mismatch reports both values, and neither
    automatically replaces or downgrades the profile; after operator approval, generate a fresh
    installer;
15. in a deliberately private `open` test deployment, confirm the dashboard visibly warns that
    anyone reachable can read the live guide and its deployment/account metadata.
16. open `/metrics` and confirm it displays separate input, cache-creation input, cache-read input,
    and output token totals plus known-value counts, a dedicated hourly token SVG, and matching
    hourly table columns;
17. feed a fixture with complete, partial, unavailable, null, and known-zero usage values and
    confirm the page labels partial totals as a lower bound, renders unknown as `—` rather than
    zero, and leaves unknown hourly SVG points blank;
17a. confirm the Usage & metrics page shows synchronized input-side and output-token device charts,
    uses distinct colors and line patterns for up to eight devices, keeps unknown points as gaps,
    and ignores only the single-device selector while retaining the other filters;
18. confirm the token page states that it covers Claude gateway traffic only, excludes Codex, and
    keeps the metrics-page body-free and open-mode visibility notices.
19. open the captured-conversations page, search for a known phrase, follow the keyset next-page
    link, and open a detail row; confirm the permanent-storage/open-mode disclosure is prominent,
    full text preserves whitespace, all four response states are distinguishable, and a dropped
    conversation queue count is shown as dropped rather than silently treated as stored. For a
    bounded search error, enter at least three consecutive Chinese characters, remove standalone
    punctuation, or split the query; an unknown search failure must remain a fixed generic message.

The first start with token accounting migrates `metrics.sqlite` schema 1 to 2 transactionally.
The first P6 start migrates schema 2 to schema 3 transactionally, adding the permanent conversation
tables and full-text index; old request rows remain readable and simply have no conversation turn.
Take the normal checkpointed backup immediately before either upgrade. If the code must be rolled
back to a pre-P6 release, stop the console, restore the matching pre-upgrade `metrics.sqlite` only,
remove `metrics.sqlite-wal` and `metrics.sqlite-shm`, then start the old code. Do not roll
`master.key` or `state.json` back for a metrics-only or conversation-UI rollback. Because schema 3
contains permanently retained conversation text, every `metrics.sqlite` snapshot and off-host copy is
sensitive and must stay root-only/encrypted.

For a real Claude account, have its owner complete the permanent owner-authorization page and
run a bounded real turn from a newly enrolled client before adding more members. The permanent
page stays tailnet-only; only the resulting device-token-authenticated gateway is public.
