#!/usr/bin/env bash
# Called only after the app image's credential scan passes, under a per-image publication lock.
set -euo pipefail
shopt -s nullglob
files=("${DIGESTS_DIRECTORY:?}"/*)
if [[ ${#files[@]} -lt 1 || ${#files[@]} -gt 2 ]]; then
  echo "Expected one or two image digests, found ${#files[@]}." >&2
  exit 1
fi
sources=()
for file in "${files[@]}"; do
  digest="${file##*/}"
  [[ "$digest" =~ ^[a-f0-9]{64}$ && -f "$file" ]] || { echo "Invalid image digest." >&2; exit 1; }
  sources+=("${IMAGE:?}@sha256:${digest}")
done

# Verify both platforms before making any tag discoverable.
manifest="$(docker buildx imagetools create --dry-run "${sources[@]}")"
for arch in amd64 arm64; do
  jq -e --arg arch "$arch" \
    'any(.manifests[]; .platform.os == "linux" and .platform.architecture == $arch)' \
    <<< "$manifest" >/dev/null || { echo "Image is missing linux/$arch." >&2; exit 1; }
done

# A slow or delayed older main run may still publish its exact commit for deployment.
# It must not move edge backward. The caller holds the same image lock through this check and push.
current_main=""
if [[ "${GITHUB_REF:-}" == refs/heads/main ]]; then
  current_main="$(git ls-remote --exit-code origin refs/heads/main | cut -f1)"
  [[ "$current_main" =~ ^[a-f0-9]{40}$ ]] || { echo "Could not resolve main." >&2; exit 1; }
fi
tag_args=()
first_tag=""
while IFS= read -r tag; do
  [[ -n "$tag" ]] || continue
  if [[ "$tag" == "$IMAGE:edge" && "$current_main" != "${GITHUB_SHA:?}" ]]; then
    continue
  fi
  tag_args+=(-t "$tag")
  [[ -n "$first_tag" ]] || first_tag="$tag"
done <<< "${TAGS:?}"
[[ -n "$first_tag" ]] || { echo "No image tags to publish." >&2; exit 1; }
docker buildx imagetools create "${tag_args[@]}" "${sources[@]}"
published_digest="$(docker buildx imagetools inspect "$first_tag" --format '{{.Manifest.Digest}}')"
[[ "$published_digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo "Published image has no digest." >&2; exit 1; }
echo "digest=$published_digest" >> "${GITHUB_OUTPUT:?}"
