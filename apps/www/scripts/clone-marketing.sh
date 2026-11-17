#!/bin/sh
# Clones the private marketing pages into src/marketing when GITHUB_MARKETING_TOKEN is set (Vercel
# builds). Without it the site builds the home page and docs alone, which production must never do.
set -eu

MARKETING_DIR="src/marketing"
REPO="github.com/rakazobot/marketing.git"

if [ -z "${GITHUB_MARKETING_TOKEN:-}" ]; then
  if [ "${VERCEL_ENV:-}" = "production" ]; then
    echo "GITHUB_MARKETING_TOKEN is not set: refusing to deploy production without marketing pages." >&2
    exit 1
  fi
  echo "No GITHUB_MARKETING_TOKEN: building without marketing pages."
  exit 0
fi

if [ -d "$MARKETING_DIR" ]; then
  echo "$MARKETING_DIR already exists."
  exit 0
fi

(set +x; git clone --quiet --depth 1 "https://x-access-token:${GITHUB_MARKETING_TOKEN}@${REPO}" "$MARKETING_DIR")
git -C "$MARKETING_DIR" remote set-url origin "https://${REPO}"
echo "Cloned marketing pages into $MARKETING_DIR."
