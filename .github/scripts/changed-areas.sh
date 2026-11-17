#!/usr/bin/env bash
# Prints which CI areas a pull request's merge commit can affect, as GitHub step outputs.
# web: anything beyond the mobile app, the marketing site, docs/ and agent notes. e2e: web, minus the
# worker, which the E2E server never loads (it imports the server adapters in-process). server (the
# Postgres journeys): web, minus the browser and desktop clients and their UI packages, which no
# journey loads. www: the marketing site, the docs/ it publishes, the workspace packages it imports
# (WWW_PACKAGES, kept equal to its dependencies by changed-areas.test.py), root config and CI.
# native: the desktop app, the computer, screen and sandbox adapters its native tests load, and
# core's desktop runtime. compose: the Compose files the Postgres upgrade drill copies. CI itself,
# the root manifest and the lockfile count for every area. Any other file, shared packages included, counts
# for web, e2e and server. all_packages: a change outside the workspace packages (root config, CI,
# scripts, infra, a package manifest) that typecheck and unit tests cannot trace through the package
# graph, so they run for every package; docs, agent notes and root markdown do not count. Every
# Dockerfile counts too: the host safeguard tests read all of them, so none may skip the gate.
# So do the test setup and stub files the root Vitest config loads for every package.
# unit_shards: the unit test shards to run, as a JSON list. Every shard when all_packages is set or
# a workspace package changed; one shard when only the marketing site or docs/ changed, which a few
# tests in other packages read; none otherwise. Renames count both paths.
set -euo pipefail

# The workspace packages apps/www depends on, directly or through each other.
WWW_PACKAGES="contracts core ui-tokens ui-web"

files="$(git diff --no-renames --name-only HEAD^1 HEAD)"
web=false
e2e=false
server=false
www=false
native=false
compose=false
all_packages=false
unit_packages=false
unit_site=false
while IFS= read -r file; do
  case "$file" in
    */Dockerfile*) all_packages=true ;;
    apps/*/package.json | packages/*/package.json | infra/*/package.json) all_packages=true ;;
    # vitest.config.ts loads these into every package's tests, which the package graph misses.
    packages/testkit/src/pin-test-env.ts | packages/testkit/src/lingui-core-macro.ts | \
      packages/testkit/src/lingui-react-macro.ts | \
      packages/chat-ui/src/native-test-stubs.tsx) all_packages=true ;;
    apps/www/* | docs/*) unit_site=true ;;
    apps/*/* | packages/*/* | infra/sandboxes/supervisor/* | infra/updater/*) unit_packages=true ;;
    .agents/skills/pr-watch/* | .agents/skills/translate/*) all_packages=true ;;
    .agents/* | .claude/*) ;;
    # Repo checks run in every Lint and typecheck job. Workflows stay below: unit and script tests
    # read the release and publish workflows directly.
    scripts/checks/*) ;;
    */*) all_packages=true ;;
    *.md) ;;
    *) all_packages=true ;;
  esac
  case "$file" in
    .github/workflows/ci.yml | .github/workflows/test-suites.yml | .github/workflows/playwright.yml | .depot/workflows/* | .github/actions/setup-workspace/* | .github/actions/start-postgres/* | .github/scripts/changed-areas.sh | .github/scripts/restore-postgres-image.sh | pnpm-lock.yaml | package.json)
      native=true
      compose=true
      www=true
      all_packages=true
      ;;
    apps/desktop/* | scripts/pnpm*.mjs | scripts/setup-worktree*.mjs | \
      packages/adapter-kit/* | packages/core/src/node/* | \
      packages/adapters/src/*computer* | packages/adapters/src/*desktop* | \
      packages/adapters/src/*sandbox* | packages/adapters/src/*host-* | \
      packages/adapters/src/home* | packages/adapters/src/native-shell* | \
      packages/adapters/src/page-browser* | packages/adapters/src/file-handle-path* | \
      packages/adapters/src/workspace-save-*)
      native=true
      ;;
    infra/compose/*) compose=true ;;
  esac
  case "$file" in
    apps/www/* | docs/*) www=true ;;
    packages/*)
      package="${file#packages/}"
      if [[ " ${WWW_PACKAGES} " == *" ${package%%/*} "* ]]; then www=true; fi
      ;;
    */* | *.md) ;;
    # Root config every app builds with.
    *) www=true ;;
  esac
  case "$file" in
    apps/*/package.json | packages/*/package.json) ;;
    .agents/* | .claude/* | apps/mobile/*) continue ;;
    # The production build checks the bundle budget; the other repo checks run on every pull request.
    scripts/checks/bundle-size*) web=true; continue ;;
    scripts/checks/*) continue ;;
    # Other workflows build or run nothing the product suites test; their own tests run above.
    .github/workflows/ci.yml | .github/workflows/test-suites.yml | .github/workflows/playwright.yml) ;;
    .github/workflows/*) continue ;;
    apps/www/* | docs/*) continue ;;
    apps/web/* | apps/desktop/* | packages/ui-web/* | packages/chat-ui/*)
      web=true
      e2e=true
      continue
      ;;
    apps/worker/*) web=true; server=true; continue ;;
    packages/adapters/*) web=true; e2e=true; server=true; continue ;;
    */*) ;;
    *.md) continue ;;
  esac
  web=true
  e2e=true
  server=true
done <<<"$files"
if [[ "$all_packages" == true || "$unit_packages" == true ]]; then
  unit_shards="[1,2,3,4]"
elif [[ "$unit_site" == true ]]; then
  unit_shards="[1]"
else
  unit_shards="[]"
fi
echo "web=$web"
echo "e2e=$e2e"
echo "server=$server"
echo "www=$www"
echo "native=$native"
echo "compose=$compose"
echo "all_packages=$all_packages"
echo "unit_shards=$unit_shards"
