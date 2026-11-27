#!/bin/sh
# Vercel's ignored build step: exit 0 skips the deployment, exit 1 builds it.
# Only production builds, and only when something the site is built from changed.
set -u

if [ "${VERCEL_ENV:-}" != "production" ]; then
  echo "Skipping non-production deployment."
  exit 0
fi

previous="${VERCEL_GIT_PREVIOUS_SHA:-}"
current="${VERCEL_GIT_COMMIT_SHA:-HEAD}"
# A redeploy or deploy hook has no new commits to compare, so it always builds.
if [ -z "$previous" ] || [ "$previous" = "$current" ] || ! git cat-file -e "$previous^{commit}" 2>/dev/null; then
  exit 1
fi

cd "$(git rev-parse --show-toplevel)" || exit 1
if git diff --quiet "$previous" "$current" -- \
  apps/www docs \
  packages/contracts packages/core packages/ui-tokens packages/ui-web \
  package.json pnpm-lock.yaml pnpm-workspace.yaml patches turbo.json tsconfig.base.json; then
  echo "No changes the site is built from since $previous."
  exit 0
fi
exit 1
