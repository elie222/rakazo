#!/bin/sh
# Clones the private marketing pages into src/marketing when GITHUB_MARKETING_TOKEN is set (Vercel
# builds). Without it the site builds the home page and docs alone.
set -eu

MARKETING_DIR="src/marketing"
REPO="github.com/rakazobot/marketing.git"

if [ -z "${GITHUB_MARKETING_TOKEN:-}" ]; then
  echo "No GITHUB_MARKETING_TOKEN: building without marketing pages."
  exit 0
fi

if [ -d "$MARKETING_DIR" ]; then
  echo "$MARKETING_DIR already exists."
  exit 0
fi

(set +x; git clone --quiet --depth 1 "https://x-access-token:${GITHUB_MARKETING_TOKEN}@${REPO}" "$MARKETING_DIR")
echo "Cloned marketing pages into $MARKETING_DIR."
