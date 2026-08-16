#!/usr/bin/env bash
# Generate the dispenser's self-signed TLS certificate and print its pin.
#
# Self-signed is the right call here: the dispenser is reached by IP, so there is
# no domain for a CA to vouch for. Clients validate the exact certificate
# fingerprint instead of a chain — see client-agent/pull.js.
#
# Usage:  ./gen-cert.sh <public-ip-or-host> [days]

set -euo pipefail

HOST="${1:?usage: ./gen-cert.sh <public-ip-or-host> [days]}"
DAYS="${2:-3650}"
HOME_DIR="${CODEX_CRED_HOME:-/var/lib/codex-credential}"
TLS_DIR="$HOME_DIR/tls"

mkdir -p "$TLS_DIR"
chmod 700 "$TLS_DIR"

# An IP goes in the SAN as IP:, a hostname as DNS:. Getting this wrong yields a
# certificate that some clients reject outright.
if [[ "$HOST" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  SAN="IP:$HOST"
else
  SAN="DNS:$HOST"
fi

openssl req -x509 -newkey rsa:2048 -sha256 -days "$DAYS" -nodes \
  -keyout "$TLS_DIR/server.key" \
  -out "$TLS_DIR/server.crt" \
  -subj "/CN=$HOST" \
  -addext "subjectAltName=$SAN" \
  2>/dev/null

chmod 600 "$TLS_DIR/server.key"
chmod 644 "$TLS_DIR/server.crt"

PIN="$(openssl x509 -in "$TLS_DIR/server.crt" -outform DER | openssl dgst -sha256 -hex | awk '{print $NF}')"

cat <<EOF
certificate written to $TLS_DIR
  server.crt  (valid $DAYS days, SAN $SAN)
  server.key  (0600)

Give every client this pin as CODEX_CRED_CERT_PIN:

  $PIN

Regenerating the certificate changes the pin, and every client will refuse to
connect until it is updated — that refusal is the pin doing its job.
EOF
