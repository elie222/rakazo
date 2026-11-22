# Connect apps

Connect Gmail, Slack, Notion, GitHub and other apps so bots can read and act in them for you.

## Connect from chat

The easiest way is to ask: "connect my Google Calendar". The bot posts a card in the chat; choose
**Connect** or **Sign in** and finish signing in with the app.

## Connect from Integrations

On web and desktop, choose **Connect apps** at the bottom of the sidebar to open **Integrations**.
Search or browse **Apps** by category. For a catalog app such as Gmail, choose **Add**.

Once an app is connected, every bot in the [space](./spaces.md) can use it. You don't set it up per
bot. Choose **Added** to open the app's details, then **Add another** to connect another account.
To rename an account, edit its label and press Enter. Choose **Remove** next to an account to
disconnect only that account, or **Uninstall** to remove the whole app.

> [!NOTE]
> The app catalog depends on your server. A self-hosted server shows it only when the operator has
> configured an app catalog. See [Self-hosting](./self-host.md). Custom sources, below, work on any
> server.

## Use your phone's calendar and reminders

In the mobile app, open a private text chat with a bot and ask what's on your phone's calendar or
ask to add an event. Keep that chat open and the app in the foreground while the bot works.
Calendar events work on iOS and Android. On iOS, you can also ask the bot to read, add, or complete
reminders. You don't need to connect a calendar account in **Integrations** to use your phone's
calendar.

If your phone asks for Calendar or Reminders access, allow it only if you want to use the feature.
Review any approval request in chat, and check the calendar or reminder list shown on your phone
before confirming the request there.

## Add your own tools

GitHub, Linear and Notion can connect directly from Integrations without a managed app catalog.
GitHub uses a personal access token and starts with read-only tools. Linear and Notion use browser
sign-in. To look beyond the built-in entries, search for an app and choose **Search public MCP directory**
to see public directory results alongside the other matches.

The **+** in **Integrations** adds tools that aren't in the catalog:

- **MCP server**: any remote MCP server at an HTTPS address. **Browse MCP servers** searches a public
  directory of them. A self-hosted server can also run local (stdio) MCP servers, which an admin
  adds; see [Tools and integrations](./self-host-integrations.md).
- **OpenAPI** and **GraphQL**: point at an API's description and the bot can call it.
- **Executor**: a tool gateway you sign in to with your Executor account. For a self-hosted
  Executor, change the URL to its own `/mcp` address.
- **From GitHub**: install a plugin from its repository. See [Build a plugin](./build-a-plugin.md).

Choose an authentication method (**No auth**, **Bearer token** or **API key header**) and then
**Verify and add**. Credentials are encrypted and never sent to the model.

**Manage MCP servers** lists every server you've added, with **Test connection**, OAuth sign-in, and
which bots can use each one.

A tool call can take a few minutes; it stops after six minutes with no answer or progress
from the server.

A server you sign in to (OAuth, including Executor) keeps one session for you, which your runs
share. During one bot run, every call to a server added with a token or no authentication reuses
one session, so servers that keep state in the session (a paused step you confirm mid-run, for
example) see the same session until the run ends. Two runs never share such a session, and each
closes when its run ends or after about ten minutes without a call. A paused step can be resumed
only while the run continues in the same Rakazo instance, within that window and the server's own.
After ten idle minutes, or when the run continues on another instance, the next call opens a fresh
session.

Executor asks the bot to resume a step that needs approval; a pause is lost if Executor restarts.
To connect with an Executor access token instead of signing in, add it as an **MCP server** with a
bearer token, using a token for one organization.

## Apps in chat

Some MCP servers come with an app: a small interactive view of a tool's result, such as a chart,
map or board. When a bot uses one of those tools, the app shows in the chat above the bot's reply,
in the web, desktop and mobile apps.

Apps run sandboxed. An app sees only that tool call and its result, reaches only the sites its
server declares, and can't call tools or see your account. A link in an app asks before it opens,
and a message an app suggests goes into the message box for you to send.

## Choose which bots use what

Bots pick the apps they need. To add an MCP server to the bot you're chatting with, open it in
**Integrations** and choose **Use in this bot**.

When a bot wants a server it hasn't used before, it asks first in the chat. Choose **Approve**, or
**Authorize** if the server needs you to sign in.

## Available in

If you have more than one [space](./spaces.md), each skill, MCP server and plugin you add has an
**Available in** choice: **All spaces**, including spaces you create later, or only the spaces you
pick. App connections stay in the space you connected them in.

## APIs without an integration

For a service with only an API key or a website login, ask the bot to save it. See
[Reusable credentials](./bot-secrets.md).
