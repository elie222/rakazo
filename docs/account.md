# Account and billing

Manage your sign-in, preferences, data and plan.

Open **Settings** from the account menu (your avatar at the bottom of the sidebar).

## Preferences

**Settings → General** holds your name, **Appearance** (light, dark or system), **Sidebar density**,
**Language** and **Timezone**. Routines run on your timezone.

Under **Advanced**:

- **Send with Enter**: on by default on desktop, off on touch devices.
- **Stream replies**: show replies as they're written.
- **Show tool activity**: list the tools a bot used under its reply. Off by default.
- **Load web images automatically**: show images from outside sites in chat.

When you open an outside link from a chat, Rakazo asks first. Choose **Always open** for a site you
trust; those sites are listed under **Trusted sites**, where you can remove them.

## Sign-in and security

Under **Security** you can **Change password** and **Add passkey** to sign in with your device
instead of a password. Some actions, such as exporting data, ask you to confirm it's you first.

## Credentials

**Settings → Vault** lists the API keys and website logins your bots can use. Protected values
show only after you confirm it's you.
You can add one, replace its value, or remove it. See [Reusable credentials](./bot-secrets.md).

## Organizations

Keep work and personal use apart, each with its own bots and billing. The account menu names the
organization you're in; open it to switch to another or choose **New organization** (on mobile, the
**Organization** row under **Account**). Rename or delete the current one in
**Settings → Organization**; deleting one cancels its plan and removes its bots and data.

To bring your team in, open **Members** there (on mobile, the **Organization** row under
**Account**, then **Organization settings**), enter an email and choose **Invite**. Each person
gets a private space of their own; [share a space](./spaces.md#share-a-space) to work together.
The owner and admins invite people, change roles and remove members.

## Usage

On web and desktop, **Settings → Usage** shows runs, tokens and cost by model. On mobile,
**Settings** shows a **Usage** summary. For a breakdown by model, type `/` at the start of a draft
in a bot chat and choose **Settings: Usage**.

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

- **Use my subscription or API key**: connect a supported [model subscription](./model-subscriptions.md)
  or [model provider](./models.md) key. Your provider's allowance and billing apply.
- **Use Rakazo credits**: model usage is paid from **Monthly credits** included in the plan. Choose
  **Add credits** for more. Monthly credits expire at renewal; credits you add don't.

Both plans come in monthly or yearly, and include monthly hours on your bots' computers.
**Settings → Billing** shows your plan, when it renews and the computer hours left. Choose
**Manage** to change it. See [pricing](https://rakazo.com/pricing) for current plans.

Cloud computers start at Standard size. On plans that offer larger sizes, the account owner can
choose a size for each computer in **Settings → Computers → Cloud computers**. The change applies
only to that computer the next time it starts. Large uses twice the allowance per hour, and
Extra large uses four times as much. Where computer sizes are available, **Billing** shows the
hours left and usage by computer in Standard hours.

**Invite friends** in the account menu gives you a link. You get a free month for each friend who
starts a trial.

> [!NOTE]
> A self-hosted server has no billing. See [Self-hosting](./self-host.md).
