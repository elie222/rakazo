# Account

A new person creates an account with name, email, and password, is taken through onboarding into a chat with their first bot, Chief, and can log out and sign back in to the same account.

## Sub-features

- `account-sign-up` creates an account from the sign-up form.
- `account-onboarding` creates Chief in the `Personal` Space and opens its chat, skipping the optional `Server integrations` step when it appears.
- `account-log-out` ends the session from the account menu.
- `account-sign-in` signs back in from the sign-in form.

## How to get to it (user POV)

- Open `/sign-up` (the app sends a signed-out first visit there).
- Open the account menu (the avatar button, bottom left) and choose `Log out`.
- Open `/sign-in` (a signed-out return visit lands there).

## Driving it with verify-stack

Preconditions:

- A ready run; `doctor` passes.
- Sign-ups are open with no allowlist, so no email verification step appears.

Run `pnpm verify:stack drive .agents/skills/verify-rakazo/drives/account.ts`.

- **Sign up.** `signUp()` fills `Your name`, `Your email address`, `Password`, and chooses `Create account`, choosing `Continue with email` first if the server offers a provider chooser. The URL moves to `/onboarding` or `/app`.
- **Onboarding.** If the heading `Server integrations` shows, choose `Skip`. The composer `Message Chief` appears and the sidebar lists `Chief`. Capture `first-chat`.
- **Log out.** Choose the button named `Account menu for <name>`, then `Log out`. The heading `Sign in to Rakazo` appears. Capture `logged-out`.
- **Sign in.** Fill `Your email address` and `Password` with the sign-up values and choose `Sign in`. The URL moves to `/app/<bot id>` and `Message Chief` is back. Capture `signed-back-in`.
- **Side effect.** `pnpm verify:stack sql 'select email from "user" order by "createdAt" desc limit 1'` shows the new `verify-<time>@rakazo.test`.

## Gotchas

- Chief's first message is a choice card ("What do you want me on first?"). It is not an error state.
- `signIn()` uses the auth API; it is setup, not proof of the sign-in form.
- The account menu button is named after the display name; the seeded account's shows its email.
- With `SIGNUP_ALLOWLIST` set, sign-up requires email verification and this recipe stops at `/sign-up?verify=email`. The stack leaves it empty.
