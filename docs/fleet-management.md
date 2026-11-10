# Bots that manage bots

A bot can manage your other active bots: create groups, organize the sidebar, rewrite
their instructions, pick their model and schedule them. This works on your active bots in the
current space, whoever created them. It is controlled per bot and is on for new bots.

## Settings

Open a bot's settings and expand **Advanced** to change **Manage other bots**. The switch is on web,
the Electron desktop app (which hosts the web UI) and mobile bot settings.

- New bots start with it on, including bots created by another bot, duplicates and imported agents.
  Duplicates do not inherit this setting from the source bot. Existing bots keep their setting;
  [**Import data**](./account.md) restores the exported setting.
- It is checked again each time a tool is called, so turning it off takes effect immediately.
- Subagents get none of the bot management tools, not even `list_fleet`.

## Which runs can use the bot management tools

Only runs you started can use them: a message you sent, a follow-up to your message, or the end of
a call. Runs started by another bot's message, a messaging channel, a spawn, tickets, a webhook or a
routine cannot use the bot management tools, including `list_fleet`. `update_bot` remains available
for changes to the calling bot, but cannot target another bot.

In Ask and Auto, a run that receives a messaging channel or webhook message while working
cannot change the bots it manages for the rest of that run. Never ask skips this restriction.
Channel or webhook messages already in the thread history before the run started are not covered.
A follow-up counts as yours only when its source message was written by you.

## Tools

- `list_fleet`: lists active bots, groups and sections, and marks the bots the caller created. With
  `bot_id`, it instead returns only that bot's full instructions and current version.
- `create_group`: creates a group from existing bots.
- `update_group`: renames a group or adds and removes members.
- `organize_bot`: sets a section (`section`), clears it (`clear_section: true`) or sets a pin on a bot
  or a group.
- `update_bot` with `bot_id`: edits another bot's name, description, color and
  notifications. It cannot change another bot's avatar image or instructions. Without `bot_id` it
  acts on the calling bot as before.
- `set_child_instructions`: replaces another bot's instructions. The bot passes the version it read
  with `list_fleet`.
- `set_child_bot_model`: sets or clears another bot's model and thinking level.
- `create_child_routine`: schedules a prompt for another bot.
- `archive_bot`: archives another bot after confirming its exact name. It cannot archive itself.

## Approval

In Ask and Auto, `set_child_instructions` and `set_child_bot_model` always show an approval card.
Auto-review and "Always allow" do not skip it, and the card offers allow or deny only.
`create_group`, `update_group`, `create_child_routine` and `archive_bot` follow the space's approval
mode like any other action. Never ask runs all of them. For group, instruction, model and routine
changes, the card lists what will actually run, resolved before the pause:

- Create group: the name and every member.
- Update group: the members added and removed, and the new name.
- Instructions: the whole new text, with the old and new lengths.
- Model change: the current and the new model (From and To), and a Thinking line when the thinking
  level is set or reset.
- Routine: the prompt and the resolved time.

If the request cannot be shown whole on the card, it is refused instead of cut off. If the bot's
instructions, model or thinking level change while the card waits, approving does not overwrite them;
the bot has to ask again.

By default, `list_fleet`, `organize_bot` and `update_bot` need no card. Space approval rules can
require one.

## What a bot cannot do

- Permanently delete a bot.
- Use bot management tools to read, request or change secrets. Instructions, profile fields and
  routine names and prompts containing credentials detected by the run's secret filter are refused.
- Change another bot's permissions, memory scope, computer, voice or app connections.
- Move a bot between spaces. Every tool works inside the space and account of the run.
- Remove itself from the group it is running in.

## Limits

- A group has 2 to 10 members.
- Instructions are at most 20,000 characters.
- `list_fleet` returns at most 200 bots and 100 groups, and says when the result is truncated.
- A bot writes at most one set of instructions per bot per run, and must pass the version it read.
  If that bot changed in the meantime, the edit is refused and the bot reads it again.

## History, events and routines

Instruction edits are saved as versions in the bot's instructions history, with the reason
"Updated by" and the name of the bot that made them.

Creating a group appends a `group.created` event to the calling bot's thread; changing a group
appends a `group.updated` event to the group's thread. Changes to a bot append `bot.updated` to that
bot's thread.

Routines a bot creates for another bot are managed by you in that bot's **Routines** screen.
The managing bot cannot list or cancel another bot's routines.
