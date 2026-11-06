#!/usr/bin/env bash
set -euo pipefail

PREFIX="${TESTCONTAINERS_HUB_IMAGE_NAME_PREFIX:-}"
IMAGE="${PREFIX}library/postgres:18-alpine"
CACHE_DIR="${RUNNER_TEMP:-/tmp}/docker-postgres-cache"
CACHE_TAR="$CACHE_DIR/postgres-18-alpine.tar"
mkdir -p "$CACHE_DIR"

if [[ -f "$CACHE_TAR" ]]; then
  docker load -i "$CACHE_TAR"
else
  docker pull "$IMAGE"
  docker save -o "$CACHE_TAR" "$IMAGE"
fi

# Testcontainers prefixes postgres without the library/ namespace used by docker run.
docker tag "$IMAGE" "${PREFIX}postgres:18-alpine"
