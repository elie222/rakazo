#!/usr/bin/env bash
# Deploys a loaded preview image for one pull request and posts or updates its link.
# Runs from the base branch with deploy credentials, so it never runs the pull request's code:
# the image only moves from the local Docker daemon to the host's registry.
#
# Env: PR, HEAD_SHA, IMAGE (local tag), FLY_API_TOKEN, FLY_ORG, REGION, GH_TOKEN, REPO,
# APP_PREFIX (default rakazo-pr), MACHINE_HIGH_WATER (default 90).
set -euo pipefail

[[ $PR =~ ^[1-9][0-9]*$ ]] || { echo "Bad pull request number" >&2; exit 1; }
[[ $HEAD_SHA =~ ^[0-9a-f]{40}$ ]] || { echo "Bad commit" >&2; exit 1; }
app="${APP_PREFIX:-rakazo-pr}-$PR"
here=$(cd "$(dirname "$0")" && pwd)

if ! python3 "$here/reclaim-capacity.py"; then
  echo "::warning::Could not reclaim Fly preview capacity. Continuing with the deploy."
fi

flyctl status --app "$app" > /dev/null 2>&1 || flyctl apps create "$app" --org "$FLY_ORG"

flyctl auth docker
remote="registry.fly.io/$app:$HEAD_SHA"
docker tag "$IMAGE" "$remote"
for attempt in 1 2 3; do
  if output=$(docker push --quiet "$remote" 2>&1); then
    printf '%s\n' "$output"
    break
  else
    push_status=$?
  fi
  printf '%s\n' "$output" >&2
  if [[ $attempt == 3 ]] || ! grep -Eq ': (500|502|503|504)([[:space:]]|$)' <<< "$output"; then
    exit "$push_status"
  fi
  echo "Fly registry returned a server error. Retrying the image upload."
  sleep "$((attempt * 5))"
done

# Fly can place a new volume using the Machine size and image when it provisions the mount.
flyctl deploy --app "$app" --config "$here/fly.toml" --image "$remote" \
  --primary-region "$REGION" --ha=false

marker="<!-- rakazo-preview -->"
commit_marker=$(python3 "$here/../../.github/scripts/pr-screenshots.py" marker "$HEAD_SHA")
body="$marker
$commit_marker
**Preview:** https://$app.fly.dev · \`preview@example.com\` / \`rakazo-preview-demo\` · ${HEAD_SHA:0:7}"
existing=$(gh api "repos/$REPO/issues/$PR/comments" --paginate \
  --jq ".[] | select(.user.login == \"github-actions[bot]\" and (.body | startswith(\"$marker\"))) | .id" |
  head -n 1)
if [[ -n $existing ]]; then
  gh api -X PATCH "repos/$REPO/issues/comments/$existing" -f body="$body" > /dev/null
else
  gh api "repos/$REPO/issues/$PR/comments" -f body="$body" > /dev/null
fi

# A close that arrived while this deployed found nothing to delete yet.
if [[ $(gh api "repos/$REPO/pulls/$PR" --jq .state) == closed ]]; then
  bash "$here/cleanup.sh"
fi
