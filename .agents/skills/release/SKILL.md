---
name: release
description: Prepare a Rakazo release - draft the CHANGELOG section from the pull requests merged since the last tag, bump the desktop version, open the release PR, and tag it once merged. Use when asked to cut, prepare, or ship a release or a new version.
---

# Release

Feature pull requests never touch `CHANGELOG.md`; the release writes it in one pass.

## 1. Gather

```sh
git fetch origin --tags
last="$(git describe --tags --abbrev=0 --match 'v[0-9]*.[0-9]*.[0-9]*' origin/main)"
git log --format='%s' "$last"..origin/main | grep -oE '\(#[0-9]+\)$' | tr -d '(#)'
```

Read each pull request's title and `## What`/`## Why`/`## Risk` (`gh pr view N --json title,body,labels`). With many PRs, fan the reading out to parallel subagents, each returning candidate entries for its slice.

## 2. Draft the section

Pick the version: patch for fixes, minor when users get new capability or self-hosters must act. Replace `## [Unreleased]` content (fold in anything already there) with `## [X.Y.Z] - YYYY-MM-DD` above the previous release, and leave an empty `## [Unreleased]` on top.

- Order: `### Security`, `### Added`, `### Changed`, `### Removed`, `### Fixed`, then `### Self-host upgrade notes` for anything an operator must do (new required settings, commands to rerun, behavior that changes by default).
- Include what a user or self-hoster would notice. Drop refactors, tests, CI, internal tooling, docs-only and marketing-site changes, and fixes to bugs that never shipped in a release.
- One entry per change, merging PRs that are steps of one feature. Say what changed for the reader in plain words, link the relevant doc, and name settings exactly.
- Every security fix gets an entry. Public repo rules apply: no metrics, private hosts, or account details.

## 3. Release PR

Bump `apps/desktop/package.json` to the new version in the same branch and open the PR titled `Release vX.Y.Z`. The maintainer reviews the changelog wording there. Right before it merges, rerun the gather against current `main` and add entries for anything merged since, because the tag covers everything up to the release PR's merge commit.

## 4. Tag

After the PR merges, tag its merge commit and push the tag:

```sh
sha="$(gh pr view <release PR> --json mergeCommit -q .mergeCommit.oid)"
git fetch origin main && git tag vX.Y.Z "$sha" && git push origin vX.Y.Z
```

The tag runs `release-desktop` (desktop builds, GitHub release text from the changelog section followed by the merged PR list) and publishes the server images. The workflow refuses a tag without a matching changelog section.
