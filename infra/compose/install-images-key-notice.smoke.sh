#!/usr/bin/env bash
# install-images.sh names ENCRYPTION_KEY and its .env once, when it generates the key,
# and never prints the key itself.
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
src="$root/install-images.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/install-images-key.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

mkdir -p "$tmp/bin" "$tmp/cwd"
# Compose stub: `config --environment` echoes the .env the installer validates.
cat > "$tmp/bin/docker" <<'STUB'
#!/usr/bin/env bash
for a in "$@"; do
  if [[ "$a" == config ]]; then
    cat >/dev/null
    grep -E '^[A-Z_]+=' .env
    exit 0
  fi
done
exit 0
STUB
printf '#!/usr/bin/env bash\nexit 1\n' > "$tmp/bin/curl"
chmod +x "$tmp/bin/docker" "$tmp/bin/curl"
cp "$root/docker-compose.images.yml" "$root/.env.images.example" "$tmp/cwd/"

run_install() {
  (cd "$tmp/cwd" && PATH="$tmp/bin:$PATH" bash "$src" --local --prepare-only 2>&1)
}

out="$(run_install)" || fail "first run failed: $out"
key="$(sed -n 's/^ENCRYPTION_KEY=//p' "$tmp/cwd/.env")"
[[ ${#key} -eq 64 ]] || fail "ENCRYPTION_KEY was not generated"
[[ "$out" == *"Back up ENCRYPTION_KEY from $(cd "$tmp/cwd" && pwd)/.env."* ]] || fail "no backup notice: $out"
[[ "$out" != *"$key"* ]] || fail "the installer printed the key"
# Part of the key leaks it too: neither half may appear.
[[ "$out" != *"${key:0:32}"* && "$out" != *"${key:32}"* ]] || fail "the installer printed part of the key"

updater_token="$(sed -n 's/^RAKAZO_UPDATER_TOKEN=//p' "$tmp/cwd/.env")"
[[ ${#updater_token} -eq 64 ]] || fail "dedicated updater token was not generated"
[[ "$out" != *"$updater_token"* ]] || fail "the installer printed the updater token"
for name in BETTER_AUTH_SECRET ENCRYPTION_KEY SCREEN_PROXY_SECRET SANDBOX_SUPERVISOR_TOKEN; do
  existing="$(sed -n "s/^${name}=//p" "$tmp/cwd/.env")"
  [[ "$existing" != "$updater_token" ]] || fail "updater token reuses an application secret"
done
! grep -q '^COMPOSE_PROFILES=' "$tmp/cwd/.env" || fail "updater profile enabled without consent"

printf '\nRAKAZO_IMAGE_TAG_PREVIOUS=sha-1111111111111111111111111111111111111111\nRAKAZO_COMPUTER_IMAGE_TAG_PREVIOUS=sha-1111111111111111111111111111111111111111\n' >> "$tmp/cwd/.env"
again="$(run_install)" || fail "second run failed: $again"
[[ "$again" == *"Keeping existing .env."* ]] || fail "second run did not keep .env: $again"
[[ "$again" != *"RAKAZO_IMAGE_TAG_PREVIOUS"* && "$again" != *"RAKAZO_COMPUTER_IMAGE_TAG_PREVIOUS"* ]] || fail "updater metadata was reported as unused"
[[ "$again" != *"Back up ENCRYPTION_KEY"* ]] || fail "notice repeated for an existing key: $again"
[[ "$again" != *"$key"* ]] || fail "the installer printed the key on rerun"
[[ "$(sed -n 's/^RAKAZO_UPDATER_TOKEN=//p' "$tmp/cwd/.env")" == "$updater_token" ]] || fail "existing updater token changed"

# A template that already carries a key is not a newly generated one.
rm "$tmp/cwd/.env"
sed -i.bak 's/^ENCRYPTION_KEY=$/ENCRYPTION_KEY=operator-supplied-key-value-0123456789abcdef/' \
  "$tmp/cwd/.env.images.example"
supplied="$(run_install)" || fail "supplied-key run failed: $supplied"
[[ "$supplied" != *"Back up ENCRYPTION_KEY"* ]] || fail "notice for a key the installer did not generate"
[[ "$supplied" != *"operator-supplied-key-value"* ]] || fail "the installer printed a supplied key"

echo "ok"
