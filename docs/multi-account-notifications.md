# Multi-account implementation handoff

The implementation follows the approved behavior in the [plan](plans/2026-11-02-1929-feat-multi-account-notifications-plan.md).
It was prepared on branch `feat/multi-account-notifications` and published as
[the feature PR](https://github.com/elie222/rakazo/pull/3123), separately from the
[review-only dogfooding evidence](https://github.com/christso/rakazo/pull/1). No merge or deployment
was performed. No live accounts, production data or infrastructure configuration were used.

## Baseline and local history

The starting checkout matched fetched `origin/main` at
`ba5574b0a35e3ece1ac219e48dd61d59ab6a1875`. The reported deployed revision,
`de8b7a890e4804831baa5b57e276a09a4f191981`, is its ancestor. This branch includes intervening
upstream changes; it is not a patch based directly on the deployed release. Current main uses
Better Auth 1.7.15, rather than the deployed 1.7.12. Review that upstream range before a release.

Initial commits are `664c4dc87` (plan), `713fb8fe4` (device registrations) and `4c65ad3ad`
(saved-account authentication). The remaining commits contain web/mobile integration and fixes
from review. `git log ba5574b0a35e3ece1ac219e48dd61d59ab6a1875..HEAD` lists the complete local
series. Commits use a generic fictional contributor identity because no Git author was configured.

## Boundaries and implementation

- Better Auth owns browser sessions and their signed HttpOnly cookies. The server lists,
  selects and removes cookie-proven accounts by user ID without returning bearer credentials.
  Its existing five-account bound is explicit: a sixth distinct login is rejected instead of
  being silently lost. Expired primary sessions can still reach other valid saved logins.
- Mobile stores signed bearers and verified account metadata in SecureStore, scoped to the
  configured server. Existing single-token sessions are adopted after authentication. Saved-account
  and revocation values use bounded encrypted SecureStore chunks, an atomic manifest, and an
  interruption-recovery journal. Old JSON remains readable; primary single-account token keys
  are unchanged. Unchanged summaries skip native writes. Native
  auth excludes ambient cookies, so signing out one bearer cannot revoke another account.
- Account selection invalidates private client state. Web reloads after stopping calls and pins
  requests to the rendered user; the API rejects a stale page before its handler runs. Native
  generation checks fence late requests, cache writes and navigation. Persisted drafts stay
  account-scoped; transient attachments and pending work follow the existing discard flow.
- The account feed reads only owned chats in member Spaces, retains per-account preferences,
  and returns event occurrence IDs. Browser polling establishes a baseline, bounds transport and
  body reads, and opens notifications through verified selection. No new Web Push service exists.
- `push_registrations` binds each account/session to its current device token. Delivery validates
  live sessions, deduplicates devices and rechecks before every send/retry. Titles and payloads
  identify the account and canonical server. Collapse IDs include server, user and thread within
  the APNs size limit. Badges aggregate live accounts sharing the device.
- Logout, revocation and password replacement preserve existing auth hooks and security events.
  Cleanup removes only the relevant login, including legacy registrations. Logout/deletion
  requests stay pinned to the original bearer even if another notification changes selection.
  Delayed summaries cannot restore removed credentials; an older tap cannot override a newer tap.
  Sign-out-all also removes saved logins on previously configured servers and attempts each
  revocation at its own origin. After signing out one account, fallback selection skips revoked
  logins and tries the next valid saved account without overriding concurrent selection.
  Notification recovery separates transient lookup errors from invalid credentials and retries
  using saved credentials. Desktop account totals hand the badge to the existing roster fallback
  when the feed is unavailable; leaving both writers clears it. Android binary upgrades remove
  only old unscoped native thread alerts before using account-scoped notification IDs.
  Failed remote sign-outs retain SecureStore records used only for revocation retries at startup
  and push registration. These credentials cannot appear in saved-account lists or register push.

## Verification

| Check | Actual result |
| --- | --- |
| Implementation focused Vitest run | 793 passed across 32 suites, covering auth, requests/caches/drafts, native saved sessions, routing, revocation, sign-out races and push delivery |
| Postgres push store suite | 12 passed, including concurrency, RLS, encryption, multi-device/account persistence, badge aggregation, legacy projection and late registration |
| Postgres account-session suite | 5 passed, including real cookie/bearer ownership, preferences, revocation/expiry, stale requests and suppressed internal background failures |
| Browser journeys after PR review | 9 passed, including real authentication, hidden-account notifications, unread counts, tab refresh/stale rejection, independent/all sign-out, logout failure/recovery and existing shell flows |
| Authorization journey after PR review | 33 passed, including bearer/cookie precedence, stale identity guard, multi-account device persistence and revocation |
| Mobile review regression run | 2,895 tests passed across all 243 mobile suites; final workspace type check passed all 22 tasks |
| Latest notification/badge follow-up | 106 tests passed across seven suites; all 22 workspace type checks passed again. Android migration was source-reviewed only; no native compilation or device run |
| Focused review regressions | 195 auth, 309 mobile account/API/push, 36 native route/notification, 45 Expo provider and 12 web account/draft tests passed |
| `pnpm check` | All 22 package tasks passed |
| `pnpm lint` | Passed with existing warnings/informational diagnostics |
| Web production build | Passed; existing bundle-size warning remains |
| Full unit run after first PR review | 19,879 passed and 711 skipped after review; three unchanged shell/backup failures remain. The final startup-notification regression separately passed its 19-test suite |

The three remaining full-suite failures also reproduce from pristine starting-revision source:
the shell environment test's failed-reader fixture still runs its command, and the two backup
permission fixtures invoke Compose against a missing fixture configuration. Those files are
unchanged. The final focused run includes the corrected mobile translation and native-ID
assertions. Ordinary verification used offline fixtures; database/browser tests used isolated
local containers, not production services.

Independent review covered correctness, security, migration, API contracts, reliability,
performance, standards, tests and maintainability. Its actionable findings were fixed and
retested. A cross-provider review attempt could not authenticate; independent in-process
adversarial review supplied that lens instead.

Two advisory coverage suggestions remain: exercise account-specific settings and the older native
module fallback through the Android mock, and add a feed test that removes Space membership after
events already exist. Review found no remaining reproduced source defect.

The initial upstream CI run found obsolete push-token/logout test assumptions and bearer sign-out
revoking another account's multi-session cookie. These were reproduced, fixed and retested locally.
The updated fork revision requires maintainer approval before upstream CI runs; no approval or
deployment was attempted. The CI screenshot in the PR is labeled as the initial revision.

## Native and product limits

No physical iOS/Android push delivery, permission flow, APNs/FCM receipt, native Kotlin build or
simulator acceptance was run. The existing iOS screenshot catalog now has an account-switcher
flow using its disposable fixtures; that flow remains unrun. Desktop Electron unit checks apply,
but its focus-stealing E2E suite was deliberately not run locally.

Android's live working-status poller covers the selected account. Expo completion/attention push
covers every registered valid account. A rebuilt Android binary adds account-aware native links,
settings and notification IDs; older binaries pause their poller when multiple accounts are saved
while Expo push continues. Native settings remain independent per account.

Accounts are selected within the configured server. Notifications from another server or an
unmatched canonical origin fail closed; select the intended server first. Legacy notifications
without account identity fail closed when multiple accounts are saved. Browser delivery requires
a running page and notification permission; visible tabs poll every five seconds and hidden tabs
every thirty seconds. Browser suspension/closure is not Web Push delivery.
Offline sign-out cannot guarantee remote revocation; sign-out-all reports incomplete server
revocation after removing local logins. Revocation-only records remain secure until the server
acknowledges sign-out; an unreachable server can still deliver pushes until it receives the retry.

Switching and notification registration cover accounts on the configured server. Saved credentials
for a previously configured server remain available for explicit server changes; this is not
cross-server notification federation. Sign-out-all clears every local saved server login. Failed
revocations for another origin retry when that server is configured again.

Legacy browser drafts have no account ownership proof and are not automatically adopted. They
remain inaccessible under scoped draft keys and are removed on explicit sign-out. Other accounts
retain their scoped drafts.

## Deployment and rollback considerations

1. Use the repository migration command. The new migration is additive, backfills existing
   encrypted registrations without changing their associated-data identity, and preserves the
   old table and constraints. No deferred drop or destructive rollback is introduced.
2. Upgrade notification workers before exposing the new API/client feature. New code maintains a
   legacy projection whenever its unique-token model can represent the registration, so ordinary
   single-account delivery survives API overlap. An old worker cannot represent every account on
   a shared token or every device; mixed workers cannot promise full multi-account delivery.
3. Roll API instances and clients, then rebuild native Android for the native poller additions.
   Keep the configured canonical API origin consistent with the origin in push payloads.
4. Retain both registration tables on rollback. Older code can use the legacy projection and the
   selected session, but cannot provide all-account/all-device delivery or expose hidden saved
   accounts. Some devices must reopen and register again. Do not drop the new table to roll back.

Large native SecureStore values can be rejected on some platforms, as described in
[Expo SecureStore documentation](https://docs.expo.dev/versions/latest/sdk/securestore/). The mobile
store now bounds each value and recovers interrupted writes without publishing partial credentials.

No new provider, dependency, environment variable or hosted service is required. Review release
changes between the deployed revision and this branch separately from this feature's migration.

## User-facing copy

The added controls are “Add account”, “Log out all accounts” on web and “Sign out all” on mobile.
“Log out all accounts?” and “Sign out all accounts?” appear only when invoked. The discard confirmation appears
only when a switch would lose transient work. “Sign in to open this notification” appears only
when the owning saved login is unavailable. Temporary verification failures use the existing
“Could not continue” and “Try again” labels, and reuse the saved credentials on retry.
“Sign in to open this account” appears only during account recovery; “Signed out on this device.
Some server sessions
could not be revoked.” reports an actual partial sign-out. “Sign out of an account before adding
another” appears only at the browser limit. These labels and contextual recovery messages are
needed to distinguish the actions and prevent private content from opening under another login.
Persistent explanatory chrome was not added. Account identity and unread counts are the switcher
itself. Web and mobile localization catalogs were updated.

## Browser evidence

These captures contain only fictional fixture accounts. They live on the independent dogfooding
branch so its draft can be closed without merging the evidence into the product tree.

![Account switcher on desktop](https://raw.githubusercontent.com/christso/rakazo/b43e1ef72bb27bc0abbbffe0b4b0e602a8b9db1c/screenshots/switcher-desktop.png)

![Account switcher at phone width](https://raw.githubusercontent.com/christso/rakazo/b43e1ef72bb27bc0abbbffe0b4b0e602a8b9db1c/screenshots/switcher-phone.png)

![Hidden account unread count](https://raw.githubusercontent.com/christso/rakazo/b43e1ef72bb27bc0abbbffe0b4b0e602a8b9db1c/screenshots/unread.png)
