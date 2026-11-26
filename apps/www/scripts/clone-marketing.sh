#!/bin/sh
# Clones the marketing pages from MARKETING_REPO into src/marketing when GITHUB_MARKETING_TOKEN is
# set. Without it the site builds the home page and docs alone, which production must never do.
set -eu

MARKETING_DIR="src/marketing"

if [ -z "${GITHUB_MARKETING_TOKEN:-}" ]; then
  if [ "${VERCEL_ENV:-}" = "production" ]; then
    echo "GITHUB_MARKETING_TOKEN is not set: refusing to deploy production without marketing pages." >&2
    exit 1
  fi
  echo "No GITHUB_MARKETING_TOKEN: building without marketing pages."
  exit 0
fi
: "${MARKETING_REPO:?Set MARKETING_REPO (owner/name) alongside GITHUB_MARKETING_TOKEN.}"
REPO="github.com/${MARKETING_REPO}.git"

if [ -d "$MARKETING_DIR" ]; then
  echo "$MARKETING_DIR already exists."
  exit 0
fi

(set +x; git clone --quiet --depth 1 "https://x-access-token:${GITHUB_MARKETING_TOKEN}@${REPO}" "$MARKETING_DIR")
git -C "$MARKETING_DIR" remote set-url origin "https://${REPO}"
echo "Cloned marketing pages into $MARKETING_DIR."
