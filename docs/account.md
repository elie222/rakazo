# Account and billing

Manage your sign-in, preferences, data and plan.

Open **Settings** from the account menu (your avatar at the bottom of the sidebar).

## Preferences

**Settings → General** holds your name, **Appearance** (light, dark or system), **Sidebar density**,
**Language**, **Timezone** and **Quiet hours**. Routines run on your timezone.

Under **Advanced**:

- **Send with Enter**: on by default on desktop, off on touch devices.
- **Stream replies**: show replies as they're written.
- **Show tool activity**: list the tools a bot used under its reply. Off by default.
- **Load web images automatically**: show images from outside sites in chat.

When you open an outside link from a chat, Rakazo asks first. Choose **Always open** for a site you
trust; those sites are listed under **Trusted sites**, where you can remove them.

### Quiet hours

Turn on **Quiet hours** and pick when they start and end, on the hour; 10 PM to 7 AM unless you
change it. Every day in that window, replies and other news in your chats don't notify you on any
device. They wait in your chats as unread. A question for you, a request to take over the screen,
and a run of yours that failed still notify you, since only you can act on them. The hours follow
your timezone, or your device's if you never set one.

## Sign-in and security

Under **Security** you can **Change password** and **Add passkey** to sign in with your device
instead of a password. Some actions, such as exporting data, ask you to confirm it's you first.

## Credentials

**Settings → Vault** lists the API keys and website logins your bots can use. Values are never shown.
You can add one, replace its value, or remove it. See [Reusable credentials](./bot-secrets.md).

## Organizations

Keep work and personal use apart, each with its own bots and billing. Choose
**Create organization** in **Settings → Organization**. Once you have two, switch between them from
the account menu. Rename or delete an organization in the same place; deleting one cancels its
plan and removes its bots and data.

## Usage

**Settings → Usage** shows runs, tokens and model cost, by model.

## Your data

In **Settings → General**:

- **Export data** downloads a zip of your account: every space's chats, files and bot workspaces.
- **Import data** loads an export, for example to move between rakazo.com and your own server.
- **Import an agent** brings in an OpenClaw, Hermes or ChatGPT assistant. See
  [Import an agent](./import-an-agent.md).
- **Delete account** emails you a code, then permanently deletes your account and data.

## Billing on rakazo.com

rakazo.com is free to try; the sidebar shows when your free period ends. To keep going, choose a
plan:

- **Use my subscription or API key**: works with your ChatGPT or Claude plan, or any
  [model provider](./models.md) key. You pay the provider for model usage.
- **Use Rakazo credits**: model usage is paid from **Monthly credits** included in the plan. Choose
  **Add credits** for more. Monthly credits expire at renewal; credits you add don't.

Both plans come in monthly or yearly, and include monthly hours on your bots' computers.
**Settings → Billing** shows your plan, when it renews and the computer hours left. Choose
**Manage** to change it. See [pricing](https://rakazo.com/pricing) for current plans.

**Invite friends** in the account menu gives you a link. You get a free month for each friend who
starts a trial.

> [!NOTE]
> A self-hosted server has no billing. See [Self-hosting](./self-host.md).
