# Wuyings

[English](./wuying-computers.md) | [简体中文](./wuying-computers.zh-CN.md)

Bots can use an existing [Wuying (无影)](https://www.aliyun.com/product/ecs/gws) Windows cloud
computer as their computer. They run PowerShell commands, read and write files, see the screen
and use the mouse and keyboard there, and you can watch or take over the screen inside Rakazo.

## How it fits together

| Part | What it does |
| --- | --- |
| ECD API (AccessKey) | Reads the desktop's state, starts it, and issues one-time screen logins |
| The desktop's MCP gateway | Runs commands, reads and writes files, takes screenshots, sends mouse and keyboard input |
| Wuying Web SDK | Draws the live screen in the computer panel, served by Rakazo at `/wuying/screen.html` |

Each bot computer's home is a folder on the desktop, `%USERPROFILE%\rakazo\<home>`. The desktop's
own disk keeps it. Every computer shares the desktop, so stopping one leaves the desktop on;
Rakazo only starts it when it is off. Turn it off from the Wuying console or its own schedule.
Deleting a computer removes only its home folder, never the desktop.

## Before you start

You need:

1. **A Wuying** (Windows), created and **assigned to an end user**, such as a
   convenience user. Screen logins are issued for that user.
2. **A RAM user's AccessKey** allowed `ecd:DescribeDesktops`, `ecd:StartDesktops` and
   `appstream-center:GetAuthCode`. Keep it to those actions.
3. **The desktop's MCP gateway URL and bearer token**. The gateway must serve the
   `wuying-system-tool` tools (`process_exec`, `fs_*`, `screen_capture`, `input_*`, `app_start`).
4. **The Web SDK files**, which are not committed. Fetch the pinned release before you build or
   start the web app; the script checks each file's SHA-256:

   ```bash
   node scripts/wuying-web-sdk.mjs
   ```

## Set it up in Settings

Admins can switch new computers to Wuying without editing the environment.

1. Make yourself an admin: add your account's email to `RAKAZO_ADMIN_EMAILS` in `.env` and
   restart the API. The email must be verified.
2. Open **Settings → Computer**.
3. Under **New computers run on**, choose **Wuying**.
4. Fill in the desktop ID, end user ID, region (defaults to `cn-hangzhou`), AccessKey ID and
   secret, MCP gateway URL and MCP token, then **Save**.

Saving first checks that the AccessKey can see the desktop and issue a screen login and, when the
desktop is running, that the gateway answers. Nothing is saved if a check fails. The connection is
stored encrypted with the deployment's `ENCRYPTION_KEY`; the AccessKey ID, AccessKey secret and MCP token are
never shown again. To change other fields later, leave the secret fields blank and they keep their
saved values. A new MCP gateway URL needs all credentials entered again. Paste the URL and token into their separate fields. The gateway must use HTTPS and a public address.

Choosing **Deployment default** sends new computers back to `SANDBOX_PROVIDER`. The saved Wuying
connection stays, so computers already on Wuying keep working; each moves to the default the next
time it starts.

### Each account's own desktop

Every account can use **Settings → Computer**; admins expand **My computers** below the deployment form. There it sets where
that account's own Team Computers run: **Deployment default** keeps them on the deployment's
computers (the admin's choice above, or `SANDBOX_PROVIDER`), and **Wuying** runs
them on a desktop the account brings, with its own AccessKey and MCP gateway. The same checks run
before it is saved.

The connection is saved to the account, not a space, and no one else can read it. A Team Computer
already running stays on its desktop and moves the next time it starts. Private Computers always
use the deployment's computers. Going back to **Deployment default** deletes the saved
connection. Accounts choose their own desktop only when `SANDBOX_PROVIDER` is not `desktop` or
`fake`.

## Or set it up with environment variables

Set `SANDBOX_PROVIDER=wuying` and these, on both the API and the worker:

| Variable | Notes |
| --- | --- |
| `WUYING_ACCESS_KEY_ID` / `WUYING_ACCESS_KEY_SECRET` | The RAM user's AccessKey |
| `WUYING_REGION_ID` | Defaults to `cn-hangzhou` |
| `WUYING_DESKTOP_ID` | The cloud computer |
| `WUYING_END_USER_ID` | The end user it is assigned to |
| `WUYING_MCP_URL` / `WUYING_MCP_TOKEN` | The desktop's MCP gateway and its bearer token |

A connection saved in Settings takes precedence over these variables, for existing Wuying
computers too. Settings has no effect when `SANDBOX_PROVIDER` is `desktop` or `fake`.

## Screen isolation

The pinned Web SDK's local mode loads `/wuying/sdk/ASP/container.html` inside the screen page.
The screen page is sandboxed without `allow-same-origin`, so its opaque origin cannot match a
runtime `frame-ancestors 'self'` policy. Only that exact runtime path omits ancestor restrictions
and Caddy's X-Frame-Options. Its CSP still denies app-origin connections, forms and objects and
keeps scripts sandboxed. It can be embedded by another site, but receives no credentials from the
server; the authenticated app supplies a short-lived screen login in the screen page's fragment.
Every other `/wuying/` path, including `screen.html`, requires same-origin ancestors and keeps
X-Frame-Options. The policy permits the SDK's exact MQTT script and embedded WebAssembly data
fetch; WebSocket connections use TLS on the default port. Nonstandard screen gateway ports are
blocked pending a verified, narrowly scoped requirement. MCP gateway ports are independent.

## Limits

- **Team Computers only.** Every bot on a desktop shares it, so Rakazo refuses Private Computers
  on Wuying.
- **One Windows account per desktop.** Every account that uses the same desktop, including every
  account left on the deployment default, shares its files, screen, input and command
  environment, including saved command credentials. A screen login opened for watching can also
  control the desktop outside Rakazo. Give each person their own desktop, or share one only
  with people you trust with each other's work.
- **One screen viewer at a time.** Wuying allows one session per end user. Opening the computer
  panel in a second browser, or the Wuying client, signs the other one out. Rakazo reconnects a
  dropped screen at most once every 30 seconds; after that, or in a background tab, it waits for
  **Retry screen**.
- **Gateway call limits.** Each call is capped at one minute, 16 KiB of command output and 1,000
  folder entries. Commands allowed longer than 50 seconds run detached, with output in
  `%USERPROFILE%\rakazo\.runs` read back every second, so they still stream.
- **Keys.** Single keys go through the gateway. Chords such as Ctrl+A go through Windows
  SendKeys from a windowless script, about a second each. Windows-key chords are not available.
- **No snapshots** and no horizontal scrolling.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Computer panel stays blank | Run `node scripts/wuying-web-sdk.mjs`; the page needs `WuyingWebSDK.js` and `sdk/ASP/container.html` |
| Screen connects, then drops | Another viewer took the session; close the other panel or the Wuying client |
| `Could not reach the Wuying desktop` on Save | Check the AccessKey's permissions, the region and the desktop ID; a running desktop's gateway must answer |
| Chinese output is garbled | The command did not run through PowerShell; Rakazo switches PowerShell output to UTF-8, other shells keep the system code page |
| Settings has no Computer provider choice | Your account is not an admin; check `RAKAZO_ADMIN_EMAILS` and that the email is verified |
