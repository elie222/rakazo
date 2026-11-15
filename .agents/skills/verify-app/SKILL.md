---
name: verify-app
description: Find a feature by its real name, see where it lives on web, desktop and mobile, and show that a change to it works with the repo's existing test and screenshot commands. Use before calling a user-facing change done, when asked to verify, QA or screenshot a feature, and whenever you need to know what a feature is called or how to reach it.
---

# Verify a change in the app

`features.json`, next to this file, lists every user-facing feature: its name, where
it lives on each surface, and what exercises it. Use its names in code review, PRs
and reports, so "the panel" means one thing.

## 1. Find the feature

Search `features.json` by name, route, or spec file. Each entry has:

- `name`: the label the UI shows, or a plain name where it shows none.
- `web`: routes as `apps/web/src/App.tsx` spells them. `?settings=<section>` and
  `?<overlay>` open over `/app`. Features that share a route live inside that
  screen; their spec shows the clicks that reach them.
- `mobile`: screens under `apps/mobile/app`, by file name.
- `desktop`: set only for what exists just in the desktop app, including a
  `?settings=<section>` it alone enables. The rest of the desktop app is the web
  UI, so its `web` entry applies.
- `evidence`: the specs and `ios:<section>` screenshot sections that exercise it.
  An empty list means nothing does.
- `product`: the PRODUCT.md section that defines its behavior. Read it before
  changing what the feature does.

A surface set to `null` does not have the feature.

## 2. Drive it

| Evidence entry                    | Command                                       | Produces                                                                      |
| --------------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------- |
| `apps/web/e2e/<name>.spec.ts`     | `pnpm test:e2e -- --spec=<name>.spec.ts`      | The screenshots the spec captures, and an HTML report in `playwright-report/` |
| `ios:<section>`                   | `pnpm ios:screenshots -- --section <section>` | PNGs and `index.html` in `test-report/ios-screenshots`                        |
| `apps/desktop/e2e/<name>.spec.ts` | CI only, see Limits                           | Setup-window screenshots in the `desktop-e2e-screenshots` artifact            |

- CI is the normal way to run a web spec (see Limits). A local `pnpm test:e2e`
  needs Docker; add `--grep=<title>` to run one test.
- CI runs the web specs on pull requests whose files can affect them, not on
  pushes to main. It skips the files in `nightlySpecs` in
  `apps/web/playwright.config.ts` and tests tagged `@nightly`; the nightly run
  covers everything. For one of those, say the PR run did not cover it.
- `pnpm ios:screenshots` is not part of CI. It needs Maestro, a Postgres server in
  `DATABASE_URL`, and a booted simulator with a debug build;
  `apps/mobile/e2e/ios-screenshots/README.md` has the details. Repeat `--section`
  for several.
- `pnpm gallery` opens every chat scenario over fake data, with no backend. Use
  it to look at a chat component in both themes; `apps/web/e2e/gallery.spec.ts`
  is its spec.

If nothing in `evidence` shows your change, extend it: add a
`captureScreenshot(page, testInfo, "<name>")` step to the feature's spec, or a
`takeScreenshot` step to the section's flow. Then list any new spec or section in
the feature's `evidence`.

## 3. Show it

Evidence is the screenshot or report that shows the changed state, not a passing
exit code. Review it with `.agents/skills/ux-declutter/SKILL.md`, then put it in
the PR; `.agents/skills/pr-watch/SKILL.md` covers picking a frame from the CI
gallery and attaching screens you captured yourself.

Say plainly what you did not verify: a surface you could not drive, a feature
with no evidence, a spec that only runs nightly.

## Limits

- Never run the desktop Playwright suite on a maintainer's machine, and leave
  the web e2e suite to CI as routine verification (AGENTS.md): update the spec,
  push, and read the CI run. Run `pnpm test:e2e` locally only when asked to.
- Nothing drives the desktop app beyond the specs in `apps/desktop/e2e`: setup,
  the local stack, launch, and window dragging.
- Nothing drives Android from a command; the "mobile Android screenshots"
  workflow is started by hand from Actions.
- A mobile screen whose feature has no `ios:` evidence has no screenshot flow.
- Do not add flags, runners, or fake services to shared test tooling to capture
  one screen (AGENTS.md). If the fixtures cannot show it, say so.

## Keep the map true

`packages/testkit/src/feature-map.test.ts` fails when a web route, settings
section, overlay, mobile screen, spec, or iOS section is in no entry, and when an
entry names a route, spec, section, or PRODUCT.md heading that does not exist.
Its message says what to add where. A route, spec, or section that belongs to no
feature goes in `uncovered` with a one-line reason.

```sh
pnpm exec vitest run packages/testkit/src/feature-map.test.ts
```
