#!/usr/bin/env bash
# Copies each tag that now names this run's digest from IMAGE to MIRROR_IMAGE. A tag publish.sh
# skipped (edge from an older main run) still names another digest, so it is not copied either.
set -euo pipefail
[[ -n "${MIRROR_TOKEN:-}" ]] || { echo "Mirroring ${MIRROR_IMAGE:?} needs a token that can write it." >&2; exit 1; }
[[ "${DIGEST:?}" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "No published digest to mirror." >&2; exit 1; }

export DOCKER_CONFIG="${RUNNER_TEMP:?}/mirror-docker-config"
mkdir -p "$DOCKER_CONFIG"
trap 'rm -rf "$DOCKER_CONFIG"' EXIT
owner="${MIRROR_IMAGE#ghcr.io/}"
owner="${owner%%/*}"
printf '%s' "$MIRROR_TOKEN" | docker login ghcr.io -u "$owner" --password-stdin >/dev/null

tag_args=()
while IFS= read -r tag; do
  [[ -n "$tag" ]] || continue
  current="$(docker buildx imagetools inspect "$tag" --format '{{.Manifest.Digest}}')"
  [[ "$current" == "$DIGEST" ]] || continue
  tag_args+=(-t "${MIRROR_IMAGE}:${tag##*:}")
done <<< "${TAGS:?}"
[[ ${#tag_args[@]} -gt 0 ]] || { echo "No published tag names ${DIGEST}." >&2; exit 1; }
docker buildx imagetools create "${tag_args[@]}" "${IMAGE:?}@${DIGEST}"
