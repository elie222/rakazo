#!/usr/bin/env bash
# Applies the issue-triage model's JSON (RESULT) to ISSUE. Only allowlisted
# values get through, so a crafted issue can at worst mislabel itself.
set -euo pipefail
TYPES='["bug","enhancement","question","documentation","self-host"]'
type=$(jq -r --argjson types "$TYPES" '.type as $t | select($types | index([$t])) | $t' <<<"$RESULT")
size=$(jq -r '.size | select(IN("small","medium","large"))' <<<"$RESULT")
duplicate=$(jq -r --argjson issue "$ISSUE" '.duplicate_of | numbers | select(. > 0 and . < $issue)' <<<"$RESULT")
# The summary is not parsed for workflow commands; the log is.
jq -r '.reason | tostring | .[:500]' <<<"$RESULT" >> "$GITHUB_STEP_SUMMARY"

current=$(gh issue view "$ISSUE" --repo "$GITHUB_REPOSITORY" --json labels --jq '[.labels[].name]')
existing_type=$(jq -r --argjson types "$TYPES" 'map(select(. as $l | $types | index([$l])))[0] // ""' <<<"$current")
has_size=$(jq 'any(startswith("size:"))' <<<"$current")
labels=()
if [[ -n "$type" && -z "$existing_type" ]]; then
  labels+=("$type")
fi
[[ -n "$size" && "$has_size" == false && "${existing_type:-$type}" != "question" ]] && labels+=("size:$size")
[[ $(jq '.priority_high == true' <<<"$RESULT") == true ]] && labels+=("priority:high")
if (( ${#labels[@]} )); then
  gh issue edit "$ISSUE" --repo "$GITHUB_REPOSITORY" --add-label "$(IFS=,; echo "${labels[*]}")"
fi

note="Possibly a duplicate of #$duplicate."
if [[ -n "$duplicate" ]] && gh issue view "$duplicate" --repo "$GITHUB_REPOSITORY" --json url --jq .url | grep -q '/issues/' &&
  [[ $(gh issue view "$ISSUE" --repo "$GITHUB_REPOSITORY" --json comments --jq "any(.comments[]; .body == \"$note\")") == false ]]; then
  gh issue comment "$ISSUE" --repo "$GITHUB_REPOSITORY" --body "$note"
fi
