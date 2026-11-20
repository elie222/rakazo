# Chat

A person types a message to a bot, sends it, sees the bot acknowledge it and then reply, and finds both messages in the thread after reloading.

## Sub-features

- `chat-send` sends a typed message from the composer.
- `chat-reply` shows the bot's progress line and final reply.
- `chat-persist` keeps the thread across a reload.
- `chat-sidebar-preview` shows the latest reply under the bot's name in the sidebar.

## How to get to it (user POV)

- Open a bot from the sidebar, type in the composer `Message <bot name>`, and press Enter.
- The same composer's `Send` button.

## Driving it with verify-stack

Preconditions:

- A ready run; `doctor` passes.
- The seeded account has Chief (any first sign-in creates it).

Run `pnpm verify:stack drive .agents/skills/verify-rakazo/drives/chat.ts`.

- **Open Chief.** `signIn()` opens `/app`, which shows the last-open bot. `Message Chief` is visible.
- **Send.** Fill `Message Chief` with `verify ping <time>` and press Enter. The message shows in the thread. Capture `typed` before sending.
- **Reply.** The paragraph `done. i handled: verify ping <time>` appears within 30 seconds, after `on it. i will work this in the background and come back with a result.` Capture `replied`.
- **Persist.** Reload. The reply is still visible. Capture `after-reload`.
- **Side effect.** `pnpm verify:stack sql 'select role, count(*)::int from messages group by role'` before and after the drive: `user` grows by one and `bot` by two. Message text is encrypted at rest, so prove the words on screen.

## Gotchas

- Replies come from the scripted model, which echoes the message. Phrases such as `cut reply` or `install the gsc cli and sign in` trigger scripted failures, cards, and computer takeovers; see `packages/adapters/src/runtime/scripted-runtime.ts` before writing a message that might match one.
- The `Send` button stays disabled while the draft is empty, and swaps to `Stop` while a run is in progress.
- After a Spaces drive, `/app` may open a different Space's Chief. Both are named `Chief`, so the recipe still passes; scope by Space when it matters.
- A reply arrives through the live notifications stream. If the reply only shows after a reload, the stream is broken, which is a real failure.
