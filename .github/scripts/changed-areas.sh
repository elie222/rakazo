#!/usr/bin/env bash
# Prints which CI areas a pull request's merge commit can affect, as GitHub step outputs.
# web: anything beyond the mobile app and agent notes. e2e: web, minus the worker and server
# adapters, which the browser never loads. server (the Postgres journeys): web, minus www, docs/,
# and the browser and desktop clients and their UI packages, which no journey loads.
# native: the desktop app, the computer and sandbox adapters its native tests load, and core's
# desktop runtime. compose: the Compose files the Postgres upgrade drill copies. CI itself, the root
# manifest and the lockfile count for every area. Any other file, shared packages included, counts
# for web, e2e and server. all_packages: a change outside the workspace packages (root config, CI,
# scripts, infra, a package manifest) that typecheck and unit tests cannot trace through the package
# graph, so they run for every package; docs, agent notes and root markdown do not count. Renames
# count both paths.
set -euo pipefail

files="$(git diff --no-renames --name-only HEAD^1 HEAD)"
web=false
e2e=false
server=false
native=false
compose=false
all_packages=false
while IFS= read -r file; do
  case "$file" in
    apps/*/package.json | packages/*/package.json | infra/*/package.json) all_packages=true ;;
    apps/*/* | packages/*/* | infra/sandboxes/supervisor/* | infra/updater/*) ;;
    .agents/skills/pr-watch/*) all_packages=true ;;
    .agents/* | .claude/* | docs/*) ;;
    */*) all_packages=true ;;
    *.md) ;;
    *) all_packages=true ;;
  esac
  case "$file" in
    .github/workflows/ci.yml | .github/scripts/changed-areas.sh | pnpm-lock.yaml | package.json)
      native=true
      compose=true
      ;;
    apps/desktop/* | scripts/pnpm*.mjs | packages/adapter-kit/* | packages/core/src/node/* | \
      packages/adapters/src/*computer* | packages/adapters/src/*desktop* | \
      packages/adapters/src/*sandbox* | packages/adapters/src/host-* | \
      packages/adapters/src/home* | packages/adapters/src/native-shell* | \
      packages/adapters/src/page-browser*)
      native=true
      ;;
    infra/compose/*) compose=true ;;
  esac
  case "$file" in
    apps/*/package.json | packages/*/package.json) ;;
    .agents/* | .claude/* | apps/mobile/*) continue ;;
    apps/www/* | docs/*) web=true; continue ;;
    apps/web/* | apps/desktop/* | packages/ui-web/* | packages/chat-ui/*)
      web=true
      e2e=true
      continue
      ;;
    apps/worker/* | packages/adapters/*) web=true; server=true; continue ;;
    */*) ;;
    *.md) continue ;;
  esac
  web=true
  e2e=true
  server=true
done <<<"$files"
echo "web=$web"
echo "e2e=$e2e"
echo "server=$server"
echo "native=$native"
echo "compose=$compose"
echo "all_packages=$all_packages"
