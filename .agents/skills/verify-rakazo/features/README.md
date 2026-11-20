# Rakazo verification map

The maintained source for verifying what a person does in the Rakazo web app. Read this index, then use the matching feature file as the recipe. Each feature has a proven drive script in [../drives/](../drives/).

## Baseline preconditions

- A run started with `pnpm verify:stack up` and a passing `pnpm verify:stack doctor`.
- The seeded account `verify@rakazo.test` exists. It starts with no bots; its first sign-in creates Chief in the `Personal` Space.
- The scripted model and fake computers are on. No real provider is reachable.
- Never drive a stack this run did not start.

## Driving conventions

- Run every recipe with `pnpm verify:stack drive <script>`; it records a trace and a final capture even on failure.
- Prefer placeholders, roles, and accessible names (`Message Chief`, `Create space`) and `data-testid` (`create-menu-trigger`) over CSS and position.
- Drives share the seeded account, so its bots and Spaces pile up across drives. Use `signUp()` when a recipe needs a clean account, and give anything you create a unique name.
- Wait for the element that proves the state, never a fixed sleep.

## Proof and skip reporting

- Capture the action and the resulting state, not only the final screen.
- Prove persistence with a reload or a second view, and check rows with `pnpm verify:stack sql`.
- Name the feature, sub-feature IDs, and entry points each piece of evidence covers.
- Report an entry point you could not reach with the command you ran and the unmet precondition. Never report it verified through a different entry point.

## Feature entry contract

Each feature file has an H1, one paragraph on the user-visible behavior, and exactly four H2s in this order: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify-stack`, `Gotchas`.

## Features

- [Account](./account.md): sign up through the form, first-run onboarding into Chief, log out, sign back in.
- [Chat](./chat.md): send a bot a message, see the reply stream in, and find both after a reload.
- [Bots](./bots.md): create a bot from the create menu or the command menu.
- [Spaces](./spaces.md): create a Space from the create menu or the command menu, and rename it in its settings.
