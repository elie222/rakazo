#!/usr/bin/env bash
# lab-ca.sh [output-dir]
# Makes a lab-only root CA and a server certificate for the mock sites. Nothing here is a real
# credential, but do not commit the output (default: harness-lab/.certs, which is git-ignored).
#   <dir>/ca.crt        root certificate: install it in the bot computer's trust store
#   <dir>/ca.key        root key (mode 600)
#   <dir>/server/lab.crt, lab.key   what the mocks serve (mount <dir>/server read-only, set HARNESS_LAB_TLS_DIR)
# Re-running keeps the CA and only reissues the server certificate; set LAB_CA_FORCE=1 to start over.
set -euo pipefail
DIR=${1:-${HARNESS_LAB_CA_DIR:-$(cd "$(dirname "$0")/.." && pwd)/.certs}}
EXTRA_NAMES=${LAB_CA_EXTRA_NAMES:-}   # comma-separated extra DNS names or IPs
mkdir -p "$DIR/server"; chmod 700 "$DIR"
umask 077
if [[ ! -s $DIR/ca.key || ${LAB_CA_FORCE:-0} == 1 ]]; then
  openssl req -x509 -newkey rsa:3072 -nodes -days 3650 -sha256 \
    -subj "/CN=Harness Lab Root CA (test only)" -keyout "$DIR/ca.key" -out "$DIR/ca.crt" \
    -addext "basicConstraints=critical,CA:TRUE,pathlen:0" -addext "keyUsage=critical,keyCertSign,cRLSign" 2>/dev/null
fi
names=(host.docker.internal localhost harness-lab-mocks)
if [[ -n $EXTRA_NAMES ]]; then IFS=, read -r -a extra <<< "$EXTRA_NAMES"; names+=("${extra[@]}"); fi
san="subjectAltName=IP:127.0.0.1,IP:::1"
for n in "${names[@]}"; do [[ -n $n ]] && san+=",DNS:$n"; done
openssl req -newkey rsa:2048 -nodes -subj "/CN=host.docker.internal" -keyout "$DIR/server/lab.key" -out "$DIR/server/lab.csr" 2>/dev/null
printf '%s\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n' "$san" > "$DIR/server/ext.cnf"
openssl x509 -req -in "$DIR/server/lab.csr" -CA "$DIR/ca.crt" -CAkey "$DIR/ca.key" -CAcreateserial \
  -days 397 -sha256 -extfile "$DIR/server/ext.cnf" -out "$DIR/server/lab.crt" 2>/dev/null
rm -f "$DIR/server/lab.csr" "$DIR/server/ext.cnf"
chmod 600 "$DIR/ca.key" "$DIR/server/lab.key"; chmod 644 "$DIR/ca.crt" "$DIR/server/lab.crt"; chmod 755 "$DIR/server"
echo "CA certificate: $DIR/ca.crt"
echo "Server cert/key (mount read-only, HARNESS_LAB_TLS_DIR): $DIR/server"
echo "Names: ${names[*]} 127.0.0.1 ::1"
