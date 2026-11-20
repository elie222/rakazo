# Spaces

A person creates a private Space, which arrives with its own Chief, and renames it from the Space's settings. The sidebar groups bots under each Space.

## Sub-features

- `spaces-create-menu` creates a Space from the sidebar's create menu.
- `spaces-create-palette` creates a Space from the command menu.
- `spaces-own-chief` gives each new Space its own Chief without onboarding.
- `spaces-rename` renames a Space from its settings, persisting across a reload.

## How to get to it (user POV)

- Choose the `Create` button at the top of the sidebar, then `New space`.
- Press Ctrl+K (Cmd+K on macOS) and choose `New private space`.
- Rename: choose `Actions for <Space name>` (the dots beside the Space's sidebar heading), then `Settings`.

## Driving it with verify-stack

Preconditions:

- A ready run; `doctor` passes.
- The seeded account has been signed in at least once.

Run `pnpm verify:stack drive .agents/skills/verify-rakazo/drives/new-space.ts`.

- **Create menu.** Choose `data-testid=create-menu-trigger`, then `data-testid=create-new-space`. In the dialog `New space`, fill `Name` with `Menu Space <n>` and choose `Create space`. The sidebar group `[data-sidebar-group^="space:"]` with that name contains a button starting with `Chief`. Capture `dialog` before creating.
- **Command menu.** Press `ControlOrMeta+K`, choose the option `New private space`, and create `Palette Space <n>` in the same dialog. Its group shows its own Chief. Capture `created`.
- **Rename.** Choose `Actions for Menu Space <n>`, then the menu item `Settings`. In `data-testid=user-settings`, the `Name` field under `data-testid=space-settings` holds the name. Fill `Menu Space <n> renamed` and press Enter. The heading `Menu Space <n> renamed` appears.
- **Persist.** Reload. The sidebar shows `Menu Space <n> renamed`. Capture `renamed`.
- **Side effect.** `pnpm verify:stack sql "select name from spaces where name like '% Space %'"` lists `Menu Space <n> renamed` and `Palette Space <n>`.

## Gotchas

- The command menu calls it `New private space`; the dialog is titled `New space`.
- Every Space has a `Chief`, so `getByRole("button", { name: /^Chief/ })` matches several. Scope to the Space's sidebar group.
- Settings opens over the app with the Space section already selected (`data-settings-section=space`); Enter in `Name` saves.
- Deleting a Space with bots asks for confirmation in an alert dialog named `Delete <name> and its <n> bot?`. It is not driven here.
