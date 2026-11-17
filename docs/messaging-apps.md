# Chat apps

Message your bots from Microsoft Teams, Slack, Telegram, WhatsApp, iMessage, SMS, or Feishu/Lark.
Replies return to the same chat app.

**Settings → Messaging** shows the chat apps configured on your server. Self-hosted operators
set them up using the [messaging setup guide](./self-host-integrations.md#messaging-apps).

| Chat app         | Direct messages        | Groups and channels                             |
| ---------------- | ---------------------- | ----------------------------------------------- |
| Microsoft Teams  | Yes                    | Not supported                                   |
| Slack            | Yes, after linking DMs | Workspace channels                              |
| Telegram         | Yes                    | Personal group linking; not broadcast channels  |
| iMessage and SMS | Yes                    | iMessage only, when supported by the connection |
| WhatsApp         | Yes                    | Not supported                                   |
| Feishu/Lark      | Yes                    | Not supported                                   |

## Link a bot to a chat app

1. Open **Settings → Messaging**.
2. Pick the bot, then choose the app under **Connect a chat app**.
3. Send the code shown from that app within 10 minutes.

From then on, messages you send there go to that bot's chat, and its replies come back to you there.
The conversation is the same one you see in the Rakazo app.

In direct messages, a voice note the chat app delivers as an audio file (Telegram, for example)
is transcribed when a voice provider that supports transcription is connected in **Voice**
settings; without one, the bot receives the audio file.

To stop, choose **Unlink**.

## Microsoft Teams

Install the custom Rakazo Teams app supplied by your server operator in the Microsoft tenant
that owns the bot registration, then open its personal chat. Your Microsoft 365 administrator
may need to upload and allow the app in that tenant's app catalog. A public Teams Store listing
is not required for this installation. Cross-company distribution is not yet verified.

In **Settings → Messaging**, pick your bot and choose `teams` under **Connect a chat app**. Send
the code to the Rakazo app in a Teams direct message within 10 minutes. Until you link it, an
unlinked personal chat does not answer ordinary messages by default.

Each person links their own Rakazo account and bot. Installing the shared Teams app does not
choose one bot for everyone. Teams channels and group chats are not supported.

If installation says **Permissions needed**, ask your administrator to check that the app is
allowed for your account. Developer Portal previews also need **Upload custom apps** enabled in
your effective Teams app setup policy. Policy changes can take a few hours; see the
[Teams setup guide](./self-host-integrations.md#microsoft-teams).

## Slack

Choose **Connect** next to Slack to add Rakazo to your Slack workspace, then **Link DMs** so direct
messages reach your bot.

The bot uses its memory and notes only for your own messages: the Slack account that connected the
workspace or linked its DMs. It answers anyone else in the workspace, including guests and other
apps, the way it answers a group chat.

A [routine](./routines.md) can also start from a **Slack message**.

## Telegram

Open the Telegram bot supplied by your server operator, start a chat, and send the link code.
If your server offers several Telegram bots, each can link to a different Rakazo bot.
For groups, follow the privacy-mode instructions below.

## iMessage and SMS

Send the link code to the number supplied by your server operator. SMS is direct-message only.
For iMessage, ask your operator whether the configured connection supports personal group linking.
Some shared numbers require you to message first before the bot can reply.

## WhatsApp

Open a direct chat with the WhatsApp number supplied by your server operator, then send the link
code. Group chats are not supported.

## Feishu/Lark

Open a direct chat with the Feishu or Lark app supplied by your server operator, then send the
link code. Group chats are not supported.

## Group chats

Personal group linking is available on Telegram and supported iMessage connections. Add the Telegram
bot or iMessage number to a group. The invite appears under **Requests** in
**Settings → Messaging**; choose **Approve** or **Decline**. Approved groups are listed under
**Conversations**, where you can **Leave** one at any time.

You can also answer an invite or a connection request by replying YES or NO to its message, within a
day and before anything else arrives from the line.

On Telegram and supported iMessage groups, linking is personal: each linked member gets
their own invite under **Requests**, and messages from approved linked members reach each approved
member's own bot. On Telegram, members who have not linked only trigger a one-time intro note in
the group. Turn privacy mode off so the bot hears the whole group: in BotFather run `/setprivacy` and
choose **Disable**, or make the bot a group admin. With privacy mode on it only sees messages that
mention it. Telegram broadcast channels are not group chats; posts there never reach your bot.

Slack rooms added through a workspace are team conversations, the only ones with per-room
settings. Open a conversation's **Settings** to decide how the bot behaves there:

- **Listening**: **Listen** to everything, or **Mentions only**. Either way, the bot answers when
  mentioned directly.
- **Room guidance**: plain-language rules for the room, such as "Engage when someone asks about
  invoices. Ignore small talk."
- **Automated senders**: for each bot or integration that posts in the room, choose **Ignore**,
  **Group updates** into a periodic digest, **Always act**, or **Treat like a person**.
