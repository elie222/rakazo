# Desktop app

The desktop app for Mac, Windows and Linux runs the same Rakazo as the web, and can also run
everything on your own computer.

## Install

Download it from [rakazo.com](https://rakazo.com). The Linux AppImage needs FUSE 2.

## Choose a server

The first time it opens, the app asks which server to use:

- **Rakazo Cloud**: sign in to your rakazo.com account.
- **This computer**: run your own Rakazo locally in Docker. If Docker isn't installed, the app links
  to Docker Desktop, OrbStack and Docker Engine. Everything, including your bots' computers, then
  runs on your machine.
- **Existing instance**: connect to a Rakazo server you or your team already run. Enter its
  **Server address** and choose **Check connection**.

To switch later, use **Change Rakazo Server…** in the app menu (Cmd+Shift+K, or Ctrl+Shift+K on
Windows and Linux).

> [!NOTE]
> A local server keeps running after you quit the app, so routines still run. Choose
> **Stop Local Stack** in the app menu to shut it down.

## Let bots use this computer

The desktop app can give bots access to the computer it runs on, to run commands and work with your
files.

- With **This computer**, the app asks **Where should bots run?** Choose **Docker** to keep bots in
  their own isolated computers, or **Use this Mac** (**Use this computer** on Windows and Linux) to
  let them work directly on yours. **Computer Access…** in the app menu changes this later, and
  **Revoke Local Computer Access** turns it off.
- With any server, turn on **Let bots use this computer** in **Settings → General** under
  **Computers**. Your computer then shows as **Connected** or **Offline** there.

Either way, the app asks **Allow bots to use this computer?** before access is granted. See
[The bot's computer](./computer.md#use-your-own-computer).

> [!WARNING]
> With **Use this Mac**, bots can run commands without asking. Don't choose it for a server other
> people use.

## Updates

The app checks for updates and downloads them in the background. When one is ready, an
**Install update** button appears at the bottom of the sidebar, or choose **Restart** when asked.
**Check for Updates…** in the app menu checks now.

## Shortcuts

- Cmd+N (Ctrl+N): create a bot, group or space.
- Cmd+K (Ctrl+K): jump to any bot.
- Ctrl+Tab / Ctrl+Shift+Tab (desktop app): switch to the next or previous bot.
- Cmd/Ctrl+Shift+Down / Cmd/Ctrl+Shift+Up (browser): switch to the next or previous bot.

The dock icon shows a badge count of unread chats.
