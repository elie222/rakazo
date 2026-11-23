#!/usr/bin/env bash
# Exercise mirroring published tags without a registry, credentials, or Docker daemon.
set -euo pipefail
root="$(cd "$(dirname "$0")/../.." && pwd)"
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT
fail() { echo "FAIL: $*" >&2; exit 1; }
mkdir -p "$scratch/bin"
cat > "$scratch/bin/docker" <<'FAKE'
#!/usr/bin/env bash
set -euo pipefail
if [[ "$1" == login ]]; then
  [[ "$*" == "login ghcr.io -u legacy-owner --password-stdin" ]] || exit 1
  [[ "$(cat)" == "$EXPECTED_TOKEN" ]] || exit 1
  [[ "$DOCKER_CONFIG" == "$RUNNER_TEMP/mirror-docker-config" ]] || exit 1
  echo login >> "$CALLS"
  exit 0
fi
[[ "$1 $2" == 'buildx imagetools' ]] || exit 1
case "$3" in
  inspect)
    # The edge tag still names an older run's image.
    if [[ "$4" == *:edge ]]; then printf 'sha256:%064d\n' 8; else echo "$DIGEST"; fi
    ;;
  create) shift 3; printf '%s\n' "$@" > "$PUSHED" ;;
  *) exit 1 ;;
esac
FAKE
chmod +x "$scratch/bin/docker"
export PATH="$scratch/bin:$PATH"
export RUNNER_TEMP="$scratch/runner"
mkdir -p "$RUNNER_TEMP"
export IMAGE=ghcr.io/new-owner/rakazo/app
export MIRROR_IMAGE=ghcr.io/legacy-owner/rakazo/app
export MIRROR_TOKEN=test-token EXPECTED_TOKEN=test-token
export DIGEST="sha256:$(printf '%064d' 1)"
export TAGS="$IMAGE:sha-abc"$'\n'"$IMAGE:edge"$'\n'"$IMAGE:v1.2"
export PUSHED="$scratch/pushed" CALLS="$scratch/calls"
mirror() {
  rm -f "$PUSHED" "$CALLS"
  bash "$root/.github/actions/publish-image/mirror.sh" > "$scratch/log" 2>&1
}

mirror || { cat "$scratch/log" >&2; fail 'mirroring the published tags failed'; }
grep -Fxq login "$CALLS" || fail 'did not log in to the mirror'
for tag in sha-abc v1.2; do
  grep -Fxq "$MIRROR_IMAGE:$tag" "$PUSHED" || fail "tag $tag was not mirrored"
done
if grep -Fq "$MIRROR_IMAGE:edge" "$PUSHED"; then fail 'mirrored a tag this run did not publish'; fi
grep -Fxq "$IMAGE@$DIGEST" "$PUSHED" || fail 'did not copy from the published digest'
[[ ! -e "$RUNNER_TEMP/mirror-docker-config" ]] || fail 'left the mirror login on disk'

MIRROR_TOKEN='' mirror && fail 'mirrored without a token'
[[ ! -e "$CALLS" ]] || fail 'logged in without a token'
DIGEST=sha256:bad mirror && fail 'mirrored a malformed digest'
[[ ! -e "$PUSHED" ]] || fail 'pushed after a malformed digest'
TAGS="$IMAGE:edge" mirror && fail 'passed with no tag naming the published digest'
[[ ! -e "$PUSHED" ]] || fail 'pushed with no matching tag'
echo 'Image mirror smoke passed.'
