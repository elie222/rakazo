# Google Tasks Inbox → Slack #tasks mirror

This lane mirrors **new or materially changed** Google Tasks Inbox items into the Slack `#tasks` channel. It is informational only: task completion, deletion, and two-way edits are out of scope.

## Routing (non-secret)

| Setting | Value |
| --- | --- |
| Slack channel | `#tasks` (`C0BQRCBPD51`) |
| Lane id | `gtasks-slack-inbox` |
| Composio Google Tasks toolkit | `GOOGLETASKS` |
| Composio Slack toolkit | `SLACK` |
| Google Tasks list | `My Tasks` (default inbox list) |

The mirror never posts to Daily notes, `#projects`, or `#gates`.

## How it runs

1. The worker reconciliation loop enqueues a stable `integration.gtasks_slack.mirror` job for each workspace/user scope whose local connection rows show **both** `GOOGLETASKS` and `SLACK` in `connected` status. The job rechecks workspace membership, connection status, and Composio readiness before listing tasks, then rechecks authorization before each Slack write.
2. The job resolves the task list titled exactly `My Tasks`, paginates active non-hidden tasks through Composio, compares a content fingerprint, and posts or updates one Slack message per external task id. It does not fall back to another task list. Task text is length-bounded and escaped, while Slack mention expansion and link/media unfurls are disabled.
3. `integration_mirrors` stores provenance (`externalId`, fingerprint, `slackMessageTs`) without secret payloads.
4. Product events of type `integration.gtasks_slack.mirrored` are appended on the connection owner’s most recently updated bot thread when one exists.

## Idempotency

- Unchanged replays are no-ops.
- A per-task database lock and the `(workspaceId, lane, externalId)` unique key serialize concurrent workers. New-message retries also reuse a deterministic Slack `client_msg_id`, so an ambiguous retry cannot create a second post if Slack accepted the first one before the ledger write failed.

## Configuration

Routing constants live in `packages/adapters/src/gtasks-slack-config.ts`. No OAuth, tokens, or live provider calls are required for unit tests; use the mocked port in `gtasks-slack-mirror.test.ts`.
