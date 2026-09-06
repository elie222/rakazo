#!/usr/bin/env bash
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
src="$root/install-images.sh"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

eval "$(awk '
  /^pull_images\(\) \{/ { p = 1 }
  p { print }
  p && /^\}/ { exit }
' "$src")"

ENV_FILE=".env"
COMPOSE_FILE="docker-compose.images.yml"
attempts=0
sleeps=0
fail_until=2

docker() {
  attempts=$((attempts + 1))
  ((attempts > fail_until))
}

sleep() {
  [[ "$1" == "2" ]] || fail "unexpected retry delay: $1"
  sleeps=$((sleeps + 1))
}

pull_images 2>/dev/null || fail "third pull attempt should succeed"
[[ "$attempts" -eq 3 ]] || fail "expected 3 pull attempts, got $attempts"
[[ "$sleeps" -eq 2 ]] || fail "expected 2 retry delays, got $sleeps"

attempts=0
sleeps=0
fail_until=3
if pull_images 2>/dev/null; then
  fail "three failed pull attempts should fail"
fi
[[ "$attempts" -eq 3 ]] || fail "expected 3 failed pull attempts, got $attempts"
[[ "$sleeps" -eq 2 ]] || fail "expected 2 retry delays on failure, got $sleeps"

echo "ok"
