# Groups and teamwork

Put several bots in one chat, or let them hand work to each other, when a job needs more than one
teammate.

## Start a group chat

On web and desktop, choose **Create** (the **+** at the top of the sidebar), then
**New group chat**. Name the group, pick 2 to 10 bots and choose **Create group**.

On mobile, tap **Create** (**+**) in the chat list, then **New group chat**. Pick 2 to 10 bots and
tap **Next**. Enter a name and tap **Create**, or leave it blank and tap **Skip** to use the default
name based on the selected bots.

Each bot keeps its own memory, computer and instructions; the group only shares the conversation.

## Who answers

- By default, a message that doesn't mention a group member reaches every member. Each can choose
  whether to reply.
- Without a mention, a direct reply to a member's message goes only to that member. If you're not
  replying to a member and one or more members are waiting for your answer, the message goes only
  to the member who asked most recently.
- **@Name** sends the message to that bot. Mention several bots to send it to those bots. Mentions
  take precedence over a direct reply or a pending question.
- **@everyone** sends the message to every member. **@all** and **@所有人** also work, unless a
  member has that name. In that case, the alias addresses just that member.

To rename the group or change who is in it, open **Group settings** from the group's header.
**Delete group** removes the group chat.

## Bots asking other bots

A bot can message another of your bots directly, for example to ask your research bot a question.
The other bot does the work in its own chat and sends the answer back, and the bot that asked
carries on with it. The chat shows **Messaged** or **Message from** with the other bot's name. Click it to read the
exchange; it is view-only.

Bots decide whom to ask from each bot's **How other bots see it** description in its settings
under **Settings** on web and desktop, or **Advanced** on mobile. Keep it to one line about what
the bot is for.

A bot messages your other bots (**Messaged** / **Message from**) only inside its own
[space](./spaces.md).

**Allow cross-space bot communication** in a bot's settings under **Permissions** does not change
that. It applies to bots linked to [chat apps](./messaging-apps.md). With it off, such a bot cannot
connect with another person's bot at all. With it on, it can connect with, and message, a bot in
another space, once that bot's setting is on and its owner approves. In a linked chat-app group,
replies also reach members' bots in other spaces only when both bots have it on.

## Subagents

For a big task, a bot can split off short-lived helpers that work in parallel and report back. Each
appears as a card in the chat showing **Running**, **Completed** or **Failed**. Subagents finish with
the task; they have no chat or memory of their own.

## Bots that build bots

A bot can create new bots, and with **Manage other bots** turned on it can also organize and
configure your bots. See [Bots that manage bots](./fleet-management.md).
