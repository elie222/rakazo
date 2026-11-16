#!/usr/bin/env bash
# Decides which commit the mobile OTA diff must start from, so a JavaScript-only
# update cannot ship to installed builds that may lack an earlier native change.
# The argument is the raw GraphQL response about the production branch's updates,
# or an empty string when the request failed. Prints one line: the base commit to
# diff from, "unknown" when the published-update lookup cannot be trusted, or
# "no-base" when no commit that safely anchors the diff could be found. Callers
# publish nothing on anything but a commit line.
set -euo pipefail

root="$(cd "$(dirname "$0")/../.." && pwd)"
response="${1:-}"

runtime="$(jq -r .expo.version "$root/apps/mobile/app.json")"

# The GraphQL API reports failures inside an HTTP 200 body, and transport failures
# leave no body; neither may read as "no published update", because a broken lookup
# must block publishing instead of widening the comparison. Some jq builds also read
# an empty body as no input and exit 0, so validate the body before parsing it.
if [[ -z "$response" ]] ||
  ! jq -e 'type == "object" and (has("data") or has("errors"))' <<<"$response" >/dev/null 2>&1; then
  published="unknown"
else
  published="$(
    jq -er --arg runtime "$runtime" '
      if has("errors") or (.data.app.byId | type) != "object" or
         (.data.app.byId | has("updateBranchByName") | not) then
        error("no usable update data")
      else
        .data.app.byId.updateBranchByName
        | if . == null then []
          elif (.updates | type) == "array" then .updates
          else error("malformed updates") end
        | . as $updates
        | map(select(.runtimeVersion == $runtime and (.isRollBackToEmbedded | not)))[0] as $update
        | if $update == null and ($updates | length) >= 50 then
            error("update lookup is incomplete")
          elif $update == null then
            ""
          elif ($update.gitCommitHash | type) != "string" or $update.gitCommitHash == "" then
            error("missing published commit")
          else
            $update.gitCommitHash
          end
      end
    ' <<<"$response"
  )" || published="unknown"
fi

# A published update this checkout has no object for cannot anchor the diff either.
if [[ -n "$published" && "$published" != "unknown" ]] &&
  ! git -C "$root" cat-file -e "${published}^{commit}" 2>/dev/null; then
  published="unknown"
fi

if [[ "$published" == "unknown" ]]; then
  echo "unknown"
  exit 0
fi

if [[ -n "$published" ]] && git -C "$root" merge-base --is-ancestor "$published" HEAD 2>/dev/null; then
  echo "$published"
  exit 0
fi

# No published update for this runtime sits on this history, so installed builds may
# lack any native change since the runtime version was introduced, not just this push.
# Every build of this runtime was made from the commit that first carried the version
# or a later one, so the oldest commit with this version anchors the diff: a version
# that returned after a bump keeps the older anchor, and builds from before the bump
# stay covered too. Walk main's first-parent history: a path-filtered log simplifies
# a merge into whichever side kept the file, so it can hide an earlier adoption behind
# a branch that carried the same version. A shallow clone cannot prove where the
# version was introduced.
if [[ "$(git -C "$root" rev-parse --is-shallow-repository)" == "true" ]]; then
  echo "no-base"
  exit 0
fi
base=""
while read -r commit; do
  if [[ "$(git -C "$root" show "$commit:apps/mobile/app.json" 2>/dev/null |
    jq -r .expo.version)" == "$runtime" ]]; then
    base="$commit"
  fi
done < <(git -C "$root" log --first-parent --format=%H -- apps/mobile/app.json)
if [[ -n "$base" ]]; then
  echo "$base"
else
  echo "no-base"
fi
