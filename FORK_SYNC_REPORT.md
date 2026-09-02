# Fork Sync Report — 2026-09-02

Worktree: `fm/rakazo-upstream-sync` @ `/Users/timoteosousa/.treehouse/rakazo-da74b8/1/rakazo`
Remotes: `origin` = Timoteohss/rakazo, `upstream` = elie222/rakazo

## Fetches
```
git fetch upstream
git fetch origin
```
Both succeeded. upstream/main advanced 478f104..c983641 (27 new commits).

## Comparison

### origin/main..upstream/main (what upstream has that origin doesn't) — 27 commits
```
c983641 fix(compose): allow generic installer download base override (#484)
26ae909 Match Grok Bot: teach in chrome, muted Routines +, simpler sidepanel (#481)
5029a13 fix(adapters): keep versioned OpenAI-compatible API roots (#482)
b59408c feat(web): add Simplified Chinese UI locale (#480)
de5b1e5 Require PR descriptions to state why a change exists (#477)
f72bd16 Reuse Pi provider sessions across bot turns (#466)
7387f95 fix(chat): show wall-clock worked duration (#461)
6e003a2 fix(ui): unify error red across web and mobile (#462)
211c30f fix(mobile): align Expo SDK 57 package versions (#467)
b81cabf fix(chat): remove steering composer helper copy (#460)
1b3687d fix(adapters): settle steering cancel and finalizeRun retries (#459)
0366353 feat(chat): deliver steering messages while bots work (#453)
35aecc1 ci: name PR-relevant Playwright frames in screenshot comments (#457)
de73adc fix(web): stop seen run errors returning after reload (#449)
bc37939 fix(api): stop resurfacing a failed run after a newer run finishes (#447)
af9de9f fix(ci): restore computer image GHCR publishing (#454)
9c7e9f9 Stop labelling older models "latest" in the model picker (#456)
17ed9bc Add password reset and provider-neutral email (#446)
2565cfa Don't fail every turn on an MCP tool enum TypeBox can't express (#450)
920a0ef feat(chat): add tappable choice prompts (#433)
92904b6 Multi-platform chat surface on Chat SDK (Slack, WhatsApp, Telegram + iMessage) (#444)
7e1ef9e Collapse bot tool activity in chat (#440)
826650c fix(chat): restore peer transcript markers (#443)
89f45cc feat(adapters): lazily load large tool schemas (#429)
cec819f fix: suppress roster attention for silent routines (#439)
28e1ba1 Publish compatible mobile changes with EAS Update (#441)
56f4b8a fix(web): keyboard completion for composer @mention picker (#432)
```
Count: `git rev-list origin/main..upstream/main --count` = 27

### upstream/main..origin/main (what origin has that upstream doesn't — fork-specific) — 3 commits
```
002fd4b Merge pull request #1 from Timoteohss/fm/rakazo-chatsdk
f2c9e5f no-mistakes(document): Fix stale messaging doc comments and changelog entry
7053799 feat(adapters): add chat-sdk generic messaging transport
```
Count: `git rev-list upstream/main..origin/main --count` = 3
Merge-base: `d2f2cef138c93ebdee58df668656638c8c31dbef` — `d2f2cef Improve mobile authentication flow (#437)`

## Decision
Fork has diverged (origin/main has 3 commits upstream lacks). Per task §4, **STOP** — no fast-forward, no force-push, no silent merge/rebase. Requires captain decision on reconciliation (merge upstream into origin/main, rebase fork commits on upstream, or other).

`origin/main` was NOT updated to `upstream/main` in this run.

## Commit 5018ceb Verification

Target: `5018ceb3692cbec3929d6f2c3789d4f5f193e9b7` — `fix(messaging): sendblue-only DM cap; drop phone.deliver alias`

Checks:
```
git log origin/main --oneline | grep 5018ceb3692cbec3929d6f2c3789d4f5f193e9b7  → no match (exit 1)
git merge-base --is-ancestor 5018ceb3692cbec3929d6f2c3789d4f5f193e9b7 origin/main  → exit 1 (not ancestor)
git log upstream/main --oneline | grep 5018ceb3692cbec3929d6f2c3789d4f5f193e9b7 → no match (exit 1)
git merge-base --is-ancestor 5018ceb3692cbec3929d6f2c3789d4f5f193e9b7 upstream/main → exit 1 (not ancestor)
git show --no-patch --oneline 5018ceb3692cbec3929d6f2c3789d4f5f193e9b7 → commit exists locally (fetched)
git branch -a --contains 5018ceb3692cbec3929d6f2c3789d4f5f193e9b7 → only remotes/upstream/chatsdk-multi-platform-chat
```

**Result: NO — commit 5018ceb3692cbec3929d6f2c3789d4f5f193e9b7 is NOT present on `origin/main` (and not on `upstream/main` either). It lives only on `upstream/chatsdk-multi-platform-chat` (merge-base with main is 826650c). Even after syncing with upstream, it would still be absent because it is not on upstream/main.**

## Reproduction Commands
```
git fetch upstream
git fetch origin
git log origin/main..upstream/main --oneline
git log upstream/main..origin/main --oneline
git log origin/main --oneline | grep 5018ceb3692cbec3929d6f2c3789d4f5f193e9b7
git merge-base --is-ancestor 5018ceb3692cbec3929d6f2c3789d4f5f193e9b7 origin/main; echo $?
git merge-base --is-ancestor 5018ceb3692cbec3929d6f2c3789d4f5f193e9b7 upstream/main; echo $?
```

