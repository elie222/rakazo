---
name: translate
description: Fill untranslated strings in the web translation catalogs (`apps/web/src/locales/*/messages.po`) and open or update the translation pull request. Use when asked to translate the app, fill translation gaps, or update the "Update translation catalogs" pull request, and on the scheduled translation run.
---

# Translate the web catalogs

`catalog-gaps.ts`, next to this file, finds and fills empty entries without touching anything else. Run it from the repo root.

## 1. Pick the branch

If an open pull request from `i18n/catalog-sync` exists (`gh pr list --head i18n/catalog-sync --state open`), check out that branch; otherwise branch `i18n/translate-<date>` from `origin/main`. Either way, bring in the newest strings before translating: merge `origin/main`, taking main's side of any `messages.po` conflict, then run `pnpm --filter @rakazo/web intl:extract` and commit the result.

Run `node .agents/skills/translate/catalog-gaps.ts check`. If every locale shows 0 untranslated, stop.

## 2. Translate

For each locale with gaps, `node .agents/skills/translate/catalog-gaps.ts list <locale>` prints the empty entries with their source files and placeholder notes. With several locales, fan out one subagent per locale (pair the small ones).

- Read the catalog's existing translations first and match their terms, tone and formality. Keep "Rakazo" and other names as they are.
- Keep every placeholder (`{name}`, `{0}`), numbered tag (`<0>…</0>`, `<1/>`) and plural `#`. In `plural`/`select` messages keep the structure and variable, translate only the branch text, and use the language's own plural categories (Russian one/few/many/other, Hebrew one/two/other, Japanese, Korean and Chinese only other).
- Short labels stay short. Read the source file when the meaning is unclear. Use the source text for code, URLs and example values.

Write translations as JSON objects `{ "<key>": "<translation>" }`, about 120 per file, using the exact `key` from `list`. Apply each file with `node .agents/skills/translate/catalog-gaps.ts apply <locale> <file.json>`; it only fills entries that are still empty.

## 3. Verify

- `node .agents/skills/translate/catalog-gaps.ts check` exits 0.
- `pnpm --filter @rakazo/web exec lingui compile --strict` passes.
- `pnpm exec vitest run apps/web/src/lib/i18n apps/web/src/lib/agent-import-locales apps/web/src/lib/bot-templates-locales` passes.
- Only translations changed: `git diff -U0 -- apps/web/src/locales | grep -E '^[-+][^-+]' | grep -vE '^[-+]msgstr '` prints nothing.

## 4. Ship

Commit only the `messages.po` files and push. On `i18n/catalog-sync`, that push starts CI and stops the sync workflow from overwriting the branch until it merges. On your own branch, open a pull request titled "Translate new web strings" that says which locales changed and that no native speaker reviewed them.

Take it to green with `.agents/skills/pr-watch/SKILL.md`. If you were asked to merge, squash-merge once checks pass and review comments are resolved.
