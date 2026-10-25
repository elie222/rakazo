Update Rakazo's dependencies in one small, reviewable batch. Follow AGENTS.md.

Use npm-check-updates to inspect the workspaces, review relevant release notes,
and apply worthwhile patch releases. You own the investigation, edits, lockfile,
compatibility fixes, and validation; no dependency list is prescribed.

Preserve intentional compatibility constraints: TypeScript 6 in Expo/Astro,
Expo's supported React/native versions, and patched Electron Builder. Leave the
pi model-catalog packages to the existing model-catalog-bump workflow. Defer
major/minor migrations and anything that needs a newer supported Node baseline.
If an update breaks compatibility, omit it rather than weakening checks.

The action uses Node 24 internally. Prepend the directory containing
`$VALIDATION_NODE` to PATH for package commands so validation also covers Node 22.
Install dependencies, generate the database client, and run workspace typechecks,
offline unit tests, and production builds. Use fake build credentials as in CI.
Check the supported Node versions and run focused tests for any fixes. Keep fixes
strictly related to the updates. Do not change workflows, agent instructions,
secrets, or unrelated code. Do not run live-provider tests or desktop Electron E2E.

If no worthwhile updates remain, leave the checkout unchanged. Otherwise leave
the complete changes uncommitted. Do not push, open a PR, or merge; the workflow
publishes the diff separately. Only leave a patch when its required local checks
pass. If validation cannot pass, revert the proposed changes and explain why.

Your final message becomes the public PR description. Use concise Why, Changes,
and Validation sections, including deferred updates and any validation limits.
Follow AGENTS.md's public-content rules; never include credentials, local paths,
account details, or business metrics. Do not claim checks ran unless they did.
