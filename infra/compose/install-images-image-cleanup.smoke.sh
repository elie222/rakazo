#!/usr/bin/env bash
set -euo pipefail
root="$(cd "$(dirname "$0")" && pwd)"
src="$root/install-images.sh"
fail() { echo "FAIL: $*" >&2; exit 1; }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/install-images-cleanup-smoke.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

setup_work() {
  local work="$1"
  mkdir -p "$work/bin" "$work/cwd"
  cat > "$work/bin/docker" <<'STUB'
#!/usr/bin/env bash
set -euo pipefail
log="${STUB_DOCKER_LOG:?}"
printf 'docker %s\n' "$*" >> "$log"
if [[ "${1:-}" == image && "${2:-}" == inspect ]]; then
  case "${!#}" in
    ghcr.io/elie222/rakazo/*) echo https://github.com/elie222/rakazo ;;
    registry.example.com:5000/rakazo-fork/*) echo https://github.com/example/rakazo-fork ;;
    missing:*) echo "No such image" >&2; exit 1 ;;
    *) echo ;;
  esac
  exit 0
fi
[[ "${1:-}" == compose ]] || exit 1
shift
for a in "$@"; do
  case "$a" in
    --help) echo "--pull --wait --wait-timeout"; exit 0 ;;
    config)
      if [[ " $* " == *" --images "* ]]; then
        printf '%s\n' \
          ghcr.io/elie222/rakazo/app:edge \
          ghcr.io/elie222/rakazo/computer:edge \
          'postgres:16@sha256:e17e86066e5ef83e0952a9347f5c792b7ece00972e2aa787a6986f471b3dd3d5' \
          registry.example.com:5000/rakazo-fork/app:edge \
          missing:1
        exit 0
      fi
      cat >/dev/null || true
      printf '%s\n' POSTGRES_PASSWORD=x POSTGRES_APP_PASSWORD=x BETTER_AUTH_SECRET=x \
        ENCRYPTION_KEY=x SCREEN_PROXY_SECRET=x SANDBOX_SUPERVISOR_TOKEN=x
      exit 0
      ;;
    up) [[ -z "${STUB_UP_FAILS:-}" ]] || exit 1 ;;
  esac
done
exit 0
STUB
  chmod +x "$work/bin/docker"
  : > "$work/cwd/docker-compose.images.yml"
  : > "$work/cwd/.env.images.example"
  printf '%s\n' POSTGRES_APP_PASSWORD=x SANDBOX_COMPUTER_EGRESS=open > "$work/cwd/.env"
  : > "$work/docker.log"
}

run_install() {
  local work="$1"
  (
    export STUB_DOCKER_LOG="$work/docker.log" PATH="$work/bin:$PATH"
    cd "$work/cwd"
    bash "$src" --offline
  )
}

setup_work "$tmp/ok"
run_install "$tmp/ok" >/dev/null 2>&1 || fail "install failed"
pruned="$(sed -n 's/^docker image prune //p' "$tmp/ok/docker.log" | sort | tr '\n' ' ')"
expected="--force --filter label=org.opencontainers.image.source=https://github.com/elie222/rakazo --force --filter label=org.opencontainers.image.source=https://github.com/example/rakazo-fork "
[[ "$pruned" == "$expected" ]] || fail "pruned [$pruned], expected [$expected]"
! grep -q '^docker image rm' "$tmp/ok/docker.log" || fail "images were removed one by one instead of pruned by origin"

setup_work "$tmp/up-fails"
(export STUB_UP_FAILS=1; run_install "$tmp/up-fails" >/dev/null 2>&1) && fail "install should fail when up fails"
! grep -qE '^docker image (rm|prune)' "$tmp/up-fails/docker.log" || fail "images were removed after a failed up"

echo "ok"
