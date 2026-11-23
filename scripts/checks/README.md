# Repo checks

Fast, offline checks of repo conventions. Run them with `pnpm checks`; CI runs every `*.test.mjs` here in the lint job, so keep each one to plain Node with no build step and well under a second.

## Ratchets

A ratchet lets a rule land before the old code is clean. Each rule freezes today's count of violations per file in a baseline. A file above its count fails, and a file missing from the baseline is allowed none, so new code obeys the rule at once.

### Add a rule

Add two files under `ratchets/`. Nothing else needs editing: rules are discovered from the directory, and the file name is the rule name.

`ratchets/<rule-name>.mjs` exports:

- `message`: what to do instead, written for whoever just tripped the rule. Name the fix, not only the ban.
- `include`, and optionally `exclude`: globs over repo-relative paths (`**`, `*`, `?`, `{a,b}`).
- `pattern`, a RegExp counted per file, or `count(text, path)` for what a regex cannot express. `count` returns its hits as a list of `{ line, text }`, so a failure can point at each one.

`ratchets/<rule-name>.baseline.json` is written by:

```
node scripts/checks/ratchets.mjs --freeze <rule-name>
```

Read a sample of the frozen hits before committing, and tighten the pattern until they are all real. A rule with no violations needs no baseline.

### Clean up

Fixing a violation needs no baseline edit: a count below the baseline passes. To lock in the gains, run:

```
node scripts/checks/ratchets.mjs --tighten <rule-name>
```

It lowers that rule's counts to the current ones and drops files that are gone or clean. It never raises a count or adds a file. Name the rule you worked on, so the PR leaves other baselines alone; without a name it tightens every rule.

### Raising a baseline

Raising a count or adding a file is a hand edit that review will see. It is fine when the violations only moved: a file was renamed or split, so the total does not grow. Otherwise fix the code, or fix the rule if the hit is a false positive.

## Compatibility shims

Code kept only so the previous release keeps working during a deploy carries `compat-shim(after vX.Y.Z)` in a comment, naming the latest release in `CHANGELOG.md` when it was added. The shim ships in the next release; once a second one follows, nothing running needs it, and `compat-shims.test.mjs` fails until it is removed. That failure usually lands on the release pull request, which removes the shims it names.
