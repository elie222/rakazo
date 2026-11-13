# Tailnet access

Let a bot reach machines on your [Tailscale](https://tailscale.com) network, such as a NAS, a home
server or a database, from its computer. Each bot joins your tailnet as its own short-lived
device, so your tailnet's access rules can limit it separately from people. Nothing Tailscale runs
on the bot's computer.

> [!NOTE]
> The **Tailnet** settings appear only when your server can put bots on a tailnet. A self-hosted
> server needs its published image and a web address the bots' computers can reach; see
> [For server operators](#for-server-operators).

## Set it up in your tailnet

You need to be an Owner or Admin of the tailnet. This is done once.

1. Add a tag for bots to your tailnet policy, and grant it only what bots may reach. For example:

   ```jsonc
   "tagOwners": { "tag:rakazo": ["autogroup:admin"] },
   "grants": [
     { "src": ["tag:rakazo"], "dst": ["tag:homelab"], "ip": ["tcp:22", "tcp:443"] }
   ]
   ```

   A tagged device gets no access of its own, so a bot reaches only what this grants. Tailscale's
   default policy allows every device to reach every other, tagged ones included; replace that rule
   with one for `autogroup:member`, which keeps your own devices' access and excludes tagged ones.
2. In the Tailscale admin console, open **Trust credentials** and create an OAuth client with write
   access to auth keys (`auth_keys`) and the tag from step 1. On a Premium or Enterprise plan, also
   give it write access to device posture attributes (`devices:posture_attributes`) to label each
   bot's device; see [Devices in your tailnet](#devices-in-your-tailnet).
3. Copy its client ID and secret.

## Connect Tailscale

Open a bot's settings, choose **Advanced**, and under **Tailnet** choose **Connect Tailscale**.
Paste the client ID and secret. If you used a tag other than `tag:rakazo`, enter it too. Rakazo
checks the client with Tailscale before saving it, and stores it encrypted.

Then turn on **Reach machines on your tailnet** for each bot that should. It is off for every bot
until you turn it on.

Your connection is yours alone. In a shared [space](./spaces.md), a bot uses your tailnet only in
chats and routines you started; when someone else messages the same bot, it has no access unless
they connect their own. Leaving a space removes your connection there.

On iOS and Android you can turn a bot's tailnet access on or off. Connect Tailscale on the web or
desktop app, where copying the client from the admin console is easier.

## What a bot does

When a bot needs a machine on your tailnet, it asks first. The card names the machine and port,
such as `nas.tail1234.ts.net:22`. **Allow once** lets that run connect to it; **Always allow**
saves it in **Settings → Approvals**, where you can change it to **Block**. Your
[approval mode](./approvals.md) applies as it does to any action.

The bot then connects from its shell with `rakazo-net`: HTTP(S) through `rakazo-net run`, SSH
through `rakazo-net nc`, and other clients through a forwarded local port. Each connection shows in
the computer's activity.

Only TCP to `*.ts.net` names and Tailscale addresses (`100.x`) works; ping and UDP don't. A bot
can't accept connections from your tailnet, and it never routes other devices' traffic.

## MCP servers on your tailnet

In **Integrations**, add an MCP server whose address is on your tailnet, such as
`http://homeassistant.tail1234.ts.net:8123/mcp` or `http://100.101.102.103:3000/mcp`, and give it
to your bots as usual. Plain HTTP is fine there: your tailnet encrypts it.

A bot calls the server from its own device on your tailnet, so its tools work only in your chats and
routines, for bots with **Reach machines on your tailnet** turned on, and only where your tailnet's
grants let the tag reach the server. Adding the server is your approval; its tool calls follow your
[approval mode](./approvals.md) like any MCP server's, with no tailnet card.

**Test connection** checks the server from one of your bots that uses it and has tailnet access.
Use a token or API key header for these servers; OAuth sign-in isn't supported on a tailnet yet.

## Devices in your tailnet

Each bot appears as its own device, named after the bot, such as `rakazo-home-lab-helper-abc123`,
with your tag. Devices are ephemeral: a bot's device joins when the bot first connects, and leaves
after ten idle minutes, when you turn the bot's access off, or when you disconnect Tailscale.

On a Premium or Enterprise plan, when the OAuth client may write device posture attributes, every
device also carries `custom:rakazoSpace`, `custom:rakazoBot` and `custom:rakazoUser`, which grants
can match with `srcPosture` to limit one bot or one person's bots. On other plans the tag alone
applies to every bot.

## Disconnect

Choose **Disconnect Tailscale** in any bot's **Tailnet** settings. Your bots' devices leave your
tailnet right away, and open connections close. To stop Rakazo from using the client anywhere,
also revoke it in the Tailscale admin console.

## For server operators

The server image ships Tailscale's `tailscaled` and `tailscale`, and the API runs one userspace
`tailscaled` per bot device. No kernel device or extra privilege is needed.

Bots' computers reach the API at the server's `WEB_ORIGIN`. When that is a loopback address such as
`http://127.0.0.1:5173`, computers can't reach it, and tailnet access stays off. Reaching a local
server from Docker computers isn't supported yet.

The API runs devices for the tunnels it receives, and the API and worker each run devices for the
MCP servers their runs call, so a bot can have a device on each. Every process checks its devices'
access each minute, and takes off any whose bot was turned off elsewhere.
