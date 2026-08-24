# Design-spec reel: Choose the right connected account

Status: `approved`

Visual mockup: [`docs/mockups/composio-multi-account.html`](./mockups/composio-multi-account.html)

## Feature message

Choose which personal or work account a Rakazo bot uses for each connected app.

## Storyboard

### Beat 1 — Start from Apps

Starting context: the Integrations overlay is open on the Apps view.

Visible evidence: Google Calendar appears as a normal app row with the existing primary action
`Connect`.

### Beat 2 — Add another account

After the first account is connected, the row changes to `1 account connected` and exposes
`Add another account`. The existing Personal connection remains visible and is not replaced.

### Beat 3 — Authorize the second account

Interaction: the user selects `Add another account` and completes the provider authorization flow.
The mockup shows a Rakazo-styled authorization step before returning to the Integrations surface.

### Beat 4 — Label the account

Visible evidence: Rakazo asks for a short label after authorization:

> Personal · personal@example.test
>
> Work · work@example.test

The label is user-facing. The provider connected-account ID remains internal.

### Beat 5 — Choose the bot default

Interaction: the user selects `Manage accounts` after saving.

Visible evidence: the account panel shows both Personal and Work, with a per-bot default control.
The user can set Work as Ari's default without reconnecting either account.

### Beat 6 — Explicit selection during work

Starting context: the bot is asked to create a calendar event.

Interaction: the request names an account, such as “put it on my personal calendar.”

Visible evidence: the tool call uses the `Personal` account and the run transcript identifies the
chosen account without exposing credentials. If the request is ambiguous and no default exists,
the bot asks a short account-choice question before performing the action.

## Interaction rules

- Keep the existing Integrations overlay and app rows; do not add a second navigation surface.
- Default account selection is per bot and per app.
- Account aliases are user-facing; provider connected-account IDs remain internal.
- Revoke targets one account, never every account for the app.
- Mutating connector actions retain Rakazo's existing approval behavior.
- Account identity is shown in tool status and audit context, never secrets.
- All motion is optional; the expanded panel and saved state must be clear with reduced motion.

## Implementation contract

- Composio sessions use multi-account mode with explicit selection when more than one account is
  available.
- Rakazo persists the Composio connected-account ID and the local display label for each connection.
- Tool discovery exposes enough account metadata for the agent to select safely.
- Existing single-account connections continue to behave as they do today.
