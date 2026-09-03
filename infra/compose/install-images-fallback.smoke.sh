#!/usr/bin/env bash
# Offline smoke for the arm64-warn fallback in install-images.sh:
# unset vs empty shell, .env, and ${NAME:-def} / ${NAME-def}.
set -euo pipefail

root="$(cd "$(dirname "$0")" && pwd)"
src="$root/install-images.sh"

extract_fn() {
  local name="$1"
  awk -v s="$name" '
    $0 ~ "^    " s "\\(\\) \\{" { p = 1 }
    p { print substr($0, 5) }
    p && $0 ~ /^    }$/ { exit }
  ' "$src"
}

eval "$(extract_fn normalize_env_tag)"
eval "$(extract_fn resolve_env_default)"

fail() { echo "FAIL: $*" >&2; exit 1; }
expect() {
  local got="$1" want="$2" msg="$3"
  [[ "$got" == "$want" ]] || fail "$msg (got '$got' want '$want')"
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
ENV_FILE="$tmp/.env"

unset BASE_TAG || true
printf '%s\n' 'BASE_TAG=fromenv' >"$ENV_FILE"
expect "$(resolve_env_default '${BASE_TAG:-def}')" "fromenv" "unset shell + .env + :-"
expect "$(resolve_env_default '${BASE_TAG-def}')" "fromenv" "unset shell + .env + -"

BASE_TAG=""
printf '%s\n' 'BASE_TAG=fromenv' >"$ENV_FILE"
expect "$(resolve_env_default '${BASE_TAG:-def}')" "def" "empty shell + :- uses default, not .env"
expect "$(resolve_env_default '${BASE_TAG-def}')" "" "empty shell + - preserves empty, not .env"

BASE_TAG="shell"
printf '%s\n' 'BASE_TAG=fromenv' >"$ENV_FILE"
expect "$(resolve_env_default '${BASE_TAG:-def}')" "shell" "set shell + :-"
expect "$(resolve_env_default '${BASE_TAG-def}')" "shell" "set shell + -"

unset BASE_TAG || true
printf '%s\n' 'BASE_TAG=' >"$ENV_FILE"
expect "$(resolve_env_default '${BASE_TAG:-def}')" "def" "unset shell + empty .env + :-"
expect "$(resolve_env_default '${BASE_TAG-def}')" "" "unset shell + empty .env + -"

unset BASE_TAG || true
printf '%s\n' 'OTHER=x' >"$ENV_FILE"
expect "$(resolve_env_default '${BASE_TAG:-def}')" "def" "unset both + :-"
expect "$(resolve_env_default '${BASE_TAG-def}')" "def" "unset both + -"

lookup_shell_or_dotenv() {
  local name="$1"
  if [[ -n "${!name+x}" ]]; then
    printf '%s' "${!name}"
    return 0
  fi
  awk -F= -v k="$name" '
    $0 ~ "^[[:space:]]*" k "=" {
      sub(/^[^=]*=/, "")
      print
      exit
    }
  ' "$ENV_FILE" 2>/dev/null || true
}

printf '%s\n' 'RAKAZO_IMAGE_TAG=fromenv' >"$ENV_FILE"
unset RAKAZO_IMAGE_TAG || true
expect "$(lookup_shell_or_dotenv RAKAZO_IMAGE_TAG)" "fromenv" "outer unset shell uses .env"
RAKAZO_IMAGE_TAG=""
expect "$(lookup_shell_or_dotenv RAKAZO_IMAGE_TAG)" "" "outer empty shell does not use .env"
RAKAZO_IMAGE_TAG="shell"
expect "$(lookup_shell_or_dotenv RAKAZO_IMAGE_TAG)" "shell" "outer set shell wins"

grep -Fq 'if [[ -n "${RAKAZO_IMAGE_TAG+x}" ]]' "$src" || fail "RAKAZO_IMAGE_TAG lookup must use +x"
grep -Fq 'if [[ -n "${RAKAZO_COMPUTER_IMAGE_TAG+x}" ]]' "$src" || fail "RAKAZO_COMPUTER_IMAGE_TAG lookup must use +x"
grep -Fq 'if [[ -n "${!name+x}" ]]' "$src" || fail "resolve_env_default must use +x for set-vs-unset"
if grep -Fq 'if [[ -n "${!name:-}" ]]' "$src"; then
  fail "resolve_env_default still treats empty as unset"
fi
if grep -Fq 'if [[ -n "${RAKAZO_IMAGE_TAG:-}" ]]' "$src"; then
  fail "outer RAKAZO_IMAGE_TAG lookup still treats empty as unset"
fi

echo "ok"
