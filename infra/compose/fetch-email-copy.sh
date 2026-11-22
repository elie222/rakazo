#!/usr/bin/env bash
# Copies the hosted deployment's email copy from the private marketing repository into
# ./email-copy before the app image builds; the image reads it through EMAIL_COPY_DIR. Without
# MARKETING_REPO_TOKEN the image keeps the public default copy, which REQUIRE_EMAIL_COPY=true
# refuses (published builds of the upstream repository).
set -euo pipefail

REPO="github.com/rakazobot/marketing.git"
target="email-copy"

if [[ -z "${MARKETING_REPO_TOKEN:-}" ]]; then
  if [[ "${REQUIRE_EMAIL_COPY:-}" == true ]]; then
    echo "MARKETING_REPO_TOKEN is not set: refusing to publish an image without the hosted email copy." >&2
    exit 1
  fi
  echo "No MARKETING_REPO_TOKEN: the image keeps the default email copy."
  exit 0
fi

work="$(mktemp -d)"
trap 'rm -rf "${work}"' EXIT
git clone --quiet --depth 1 --filter=blob:none --sparse \
  "https://x-access-token:${MARKETING_REPO_TOKEN}@${REPO}" "${work}/marketing"
git -C "${work}/marketing" sparse-checkout set emails
[[ -d "${work}/marketing/emails" ]] || { echo "The marketing repository has no emails/ directory." >&2; exit 1; }
rm -rf "${target}"
cp -R "${work}/marketing/emails" "${target}"
echo "Copied the hosted email copy into ${target}."
