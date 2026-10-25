#!/usr/bin/env bash
set -euo pipefail

patch=$1
# Inspect in a temporary index before changing any checkout files.
export GIT_INDEX_FILE="$RUNNER_TEMP/dependency-update.index"
git read-tree HEAD
git apply --cached "$patch"
git diff --cached --name-only --no-renames -z > "$RUNNER_TEMP/dependency-update.paths"
while IFS= read -r -d '' file; do
  case "$file" in
    .github|.github/*|.agents|.agents/*|.codex|.codex/*|.claude|.claude/*|\
    AGENTS.md|*/AGENTS.md|CLAUDE.md|*/CLAUDE.md|SKILL.md|*/SKILL.md|.env*|*/.env*)
      echo "::error::Dependency patch touches workflows, instructions, or environment files."
      exit 1 ;;
  esac
done < "$RUNNER_TEMP/dependency-update.paths"
unset GIT_INDEX_FILE
git apply --index "$patch"
