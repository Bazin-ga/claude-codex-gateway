# Deploying credential-console

The console is normally deployed on the same host as the Codex dispenser, so it can import that
credential home read-only over the local filesystem. That is a convenience, not a requirement: the
console runs on any host that can reach the dispenser over the network, and the read-only import is
simply unavailable when the Codex credential home is on a different machine.

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
credential metadata through the systemd unit's `SupplementaryGroups=codex-credential`. Do not grant
access to its client-token registry or `/var/lib/codex-credential/secret`.

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
sudo install -m 0644 install/credential-console.service \
  /etc/systemd/system/credential-console.service
sudo systemctl daemon-reload
sudo systemctl enable --now credential-console
curl -fsS http://127.0.0.1:9080/health
```

## Administrator authentication

For a tailnet-only deployment, use Tailscale identity and do not configure a separate
application password:

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

For deployments that need a separate application password, leave
`CREDENTIAL_CONSOLE_ADMIN_AUTH=password` and bootstrap it as follows.

Generate a password into a temporary mode-600 file. Do not put it in shell history or an
environment variable. Run this before starting the service on a first deployment. To initialize
or rotate it later, stop the service first:

```bash
umask 077
openssl rand -base64 24 > /tmp/credential-console-admin-password
sudo systemctl stop credential-console 2>/dev/null || true
sudo -u credential-console \
  CREDENTIAL_CONSOLE_HOME=/var/lib/credential-console \
  node /opt/claude-codex-gateway/credential-console/cli.js \
  init-admin --password-file /tmp/credential-console-admin-password
if sudo systemctl is-enabled --quiet credential-console; then
  sudo systemctl start credential-console
fi
```

Give the password to the administrator through a private channel, then remove the temporary
file. The password can later be rotated with the same command.

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

The server holds a single-writer lock on the credential home for its lifetime. The `init-key`,
`init-admin`, and `import-codex` commands acquire the same lock and fail fast while the service is
running. Stop the service before running any of them. `list` is read-only and does not acquire the
lock.

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

Publish only the Claude runtime gateway on the separate public Funnel port:

```bash
sudo tailscale funnel --bg --https=10000 --set-path=/claude http://127.0.0.1:9080/claude
sudo tailscale funnel status
```

The `/claude` suffix on both sides is intentional. `--set-path` strips the public mount
prefix before proxying; adding it to the target preserves the path expected by the
credential console (`/claude/v1/...`).

Port 443 remains Serve-only and private. Port 10000 is Funnel-only and public, with only the
`/claude` mount configured; Funnel traffic does not carry Tailscale identity headers. Never
configure Funnel at `/` or on port 443 for this service.

Tailscale reports a URL such as
`https://<console-host>.<your-tailnet>.ts.net`. Put that exact origin and the chosen
administrator-auth mode in `/etc/credential-console.env`, restart `credential-console`,
and verify the generated enrollment links use it.

This command rewrites the file. If you already added the `CREDENTIAL_CONSOLE_CODEX_*` lines
from [Codex member self-service](#codex-member-self-service), re-add them afterwards and
restart the service again — the console fails closed and simply hides Codex self-service when
any of the three is missing.

```bash
sudo sh -c 'umask 077; printf "%s\n" \
  "CREDENTIAL_CONSOLE_PUBLIC_URL=https://<console-host>.<your-tailnet>.ts.net" \
  "CREDENTIAL_CONSOLE_CLAUDE_GATEWAY_URL=https://<console-host>.<your-tailnet>.ts.net:10000/claude" \
  "CREDENTIAL_CONSOLE_ADMIN_AUTH=tailscale" \
  "CREDENTIAL_CONSOLE_USAGE_REFRESH_INTERVAL_MS=3600000" \
  > /etc/credential-console.env'
sudo systemctl restart credential-console
```

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
the same way and keys the login-attempt limiter.

If you nevertheless terminate TLS with your own proxy, mount only `/claude`, and clear both
headers on the way in — with nginx, `proxy_set_header Tailscale-User-Login "";` and
`proxy_set_header X-Forwarded-For "";` inside that location block.

## Backup, restore, and rollback

Treat `master.key` and `state.json` as one recovery unit. A key from one backup combined with
ciphertext from another decrypts nothing. `usage.json` is a regenerable quota cache and is not
critical to recovery; include it in a point-in-time backup when it exists.

### Create and transfer a backup

1. Stop the service briefly and create a root-only snapshot of the recovery pair and, when it
   exists, the quota cache. Replace
   `<backup-id>` with a unique UTC timestamp or change identifier:

```bash
set -euo pipefail
backup_id='<backup-id>'
console_home=/var/lib/credential-console
snapshot_dir=/var/backups/credential-console/snapshots/$backup_id
sudo systemctl stop credential-console
sudo install -d -o root -g root -m 0700 "$snapshot_dir"
files=(master.key state.json)
if sudo test -f "$console_home/usage.json"; then
  files+=(usage.json)
fi
for file in "${files[@]}"; do
  sudo install -o root -g root -m 0600 "$console_home/$file" "$snapshot_dir/$file"
done
(cd "$snapshot_dir" && sudo sha256sum "${files[@]}") \
  | sudo tee "$snapshot_dir/SHA256SUMS" >/dev/null
sudo chmod 0600 "$snapshot_dir/SHA256SUMS"
(cd "$snapshot_dir" && sudo sha256sum --check SHA256SUMS)
sudo systemctl start credential-console
curl -fsS http://127.0.0.1:9080/health
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
sudo systemctl stop credential-console
sudo install -d -o root -g root -m 0700 "$rollback_dir"
sudo install -o root -g root -m 0600 \
  /var/lib/credential-console/{master.key,state.json} "$rollback_dir"/
if sudo test -f /var/lib/credential-console/usage.json; then
  sudo install -o root -g root -m 0600 \
    /var/lib/credential-console/usage.json "$rollback_dir"/
fi
```

2. Restore `master.key` and `state.json` as the matched pair from that single backup. Restore
   `usage.json` when available, or omit it and allow the service to regenerate the cache:

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
sudo systemctl start credential-console
curl -fsS http://127.0.0.1:9080/health
```

3. If health or functional checks fail, roll back to the pre-restore matched pair:

```bash
set -euo pipefail
sudo systemctl stop credential-console
sudo install -o credential-console -g credential-console -m 0600 \
  "$rollback_dir/master.key" /var/lib/credential-console/master.key
sudo install -o credential-console -g credential-console -m 0600 \
  "$rollback_dir/state.json" /var/lib/credential-console/state.json
if sudo test -f "$rollback_dir/usage.json"; then
  sudo install -o credential-console -g credential-console -m 0600 \
    "$rollback_dir/usage.json" /var/lib/credential-console/usage.json
fi
sudo systemctl start credential-console
curl -fsS http://127.0.0.1:9080/health
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

For a real Claude account, have its owner complete the permanent owner-authorization page and
run a bounded real turn from a newly enrolled client before adding more members. The permanent
page stays tailnet-only; only the resulting device-token-authenticated gateway is public.
