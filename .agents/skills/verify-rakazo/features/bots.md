# Bots

A person creates a new bot by name, lands in its empty chat, and finds it in the sidebar, including after a reload.

## Sub-features

- `bots-create-menu` creates a bot from the sidebar's create menu.
- `bots-create-palette` creates a bot from the command menu.
- `bots-persist` lists the new bot in the sidebar after a reload.

## How to get to it (user POV)

- Choose the `Create` button (plus icon) at the top of the sidebar, then `New bot`.
- Press Ctrl+K (Cmd+K on macOS) and choose `New bot`.
- With no bots in the Space, the empty chat area offers a `New bot` button.

## Driving it with verify-stack

Preconditions:

- A ready run; `doctor` passes.
- The seeded account has been signed in at least once, so Chief exists.

Run `pnpm verify:stack drive .agents/skills/verify-rakazo/drives/new-bot.ts`.

- **Create menu.** Choose `data-testid=create-menu-trigger`, then `data-testid=create-new-bot`. The dialog `data-testid=create-bot-dialog` appears. Fill `Name your Bot` with `Menu Bot <n>` and choose `Create`. The dialog closes and `Message Menu Bot <n>` appears. Capture `from-create-menu`.
- **Command menu.** Press `ControlOrMeta+K`. In the dialog `Command menu`, choose the option `New bot`. The same dialog appears; create `Palette Bot <n>` the same way.
- **Persist.** Reload. The sidebar `data-testid=bots-sidebar` has buttons starting with both names. Capture `after-reload`.
- **Side effect.** `pnpm verify:stack sql "select name from bots where name like 'Menu Bot %' or name like 'Palette Bot %'"` lists both bots.

## Gotchas

- The empty-Space `New bot` button only shows in a Space with no bots, which the seeded account never has. It is not driven; reach it with a new Space whose Chief was deleted.
- Sidebar bot buttons are named with the bot name plus the time and latest message, so match with `^<name>`, not an exact name.
- A server-rejected create shows `data-testid=create-bot-error` inside the dialog, which stays open.
