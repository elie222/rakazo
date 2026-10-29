# Manage the bots it creates

A bot can set up other bots the way you would: create groups, organize the sidebar, rewrite
the instructions of bots it created, pick their model and schedule them. This is controlled per
bot and is off by default.

## Turning it on

Open a bot's settings, expand **Advanced** and turn on **Manage the bots it creates**. The switch is on web,
the Electron desktop app (which hosts the web UI) and mobile bot settings.

- It is off for every new bot. A bot that creates another bot, or a duplicate, starts with it off;
  the switch is never inherited.
- It is checked again each time a tool is called, so turning it off takes effect immediately.
- Subagents get none of the bot management tools, not even `list_fleet`.

## Which runs can use the bot management tools

Only runs you started can use them: a message you sent, a follow-up to your message, or the end of
a call. Runs started by another bot's message, a messaging channel, a spawn, tickets, a webhook or a
routine get none of the bot management tools, including `list_fleet`. The tools are hidden from them and
rejected if called.

A run that has received a message from a messaging channel or a webhook while it was working
cannot change the bots it manages for the rest of that run. Channel or webhook messages that were already in
the thread history before the run started are not covered by this rule. A follow-up counts as yours only when every
message it answers came from you in the app.

## Tools

- `list_fleet`: lists active bots, groups and sections. With `bot_id` of a bot it created, it instead
  returns only that bot's full instructions and current version.
- `create_group`: creates a group from existing bots.
- `update_group`: renames a group or adds and removes members.
- `organize_bot`: sets a section (`section`), clears it (`clear_section: true`) or sets a pin on a bot
  or a group.
- `update_bot` with `bot_id`: edits a child bot's name, description, color and
  notifications. It never changes instructions. Without `bot_id` it acts on the calling bot as
  before.
- `set_child_instructions`: replaces a child bot's instructions. The bot passes the version it read
  with `list_fleet`.
- `set_child_bot_model`: sets or clears a child bot's model and thinking level.
- `create_child_routine`: schedules a prompt for a child bot.

## Approval

`create_group`, `update_group`, `set_child_instructions`, `set_child_bot_model` and
`create_child_routine` always show an approval card. Auto-review and "Always allow" do not skip it,
and the card offers allow or deny only. The card lists what will actually run, resolved before the
pause:

- Create group: the name and every member.
- Update group: the members added and removed, and the new name.
- Instructions: the whole new text, with the old and new lengths.
- Model change: the current and the new model (From and To), and a Thinking line when the thinking
  level is set or reset.
- Routine: the prompt and the resolved time.

If the request cannot be shown whole on the card, it is refused instead of cut off. If the child's
instructions, model or thinking level change while the card waits, approving does not overwrite them;
the bot has to ask again.

`list_fleet`, `organize_bot` and `update_bot` need no card.

## What a bot cannot do

- Permanently delete a bot.
- Read, request or change secrets. Instructions, profile fields and routine names and prompts that
  contain a credential are refused.
- Edit a bot it did not create. It can only change a section or pin on any of your bots.
- Move a bot between spaces. Every tool works inside the space and account of the run.
- Remove itself from the group it is running in.

## Limits

- A group has 2 to 10 members.
- Instructions are at most 20,000 characters.
- `list_fleet` returns at most 200 bots and 100 groups, and says when the result is truncated.
- A bot writes at most one set of instructions per child per run, and must pass the version it read.
  If the child changed in the meantime, the edit is refused and the bot reads it again.

## History, events and routines

Instruction edits are saved as versions in the bot's instructions history, with the reason
"Updated by" and the name of the bot that made them.

Creating a group appends a `group.created` event to the calling bot's thread; changing a group
appends a `group.updated` event to the group's thread. Changes to a bot append `bot.updated` to that
bot's thread.

Routines a bot creates for a child are managed by you in the child's **Routines** screen. A bot
cannot list or cancel them.
