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

1. The worker reconciliation loop enqueues `integration.gtasks_slack.mirror` jobs for workspaces where the same user has **both** `GOOGLETASKS` and `SLACK` connections in `connected` status (Composio Plugins model).
2. The job lists inbox tasks through Composio, compares a content fingerprint, and posts or updates a single Slack message per external task id.
3. `integration_mirrors` stores provenance (`externalId`, fingerprint, `slackMessageTs`) without secret payloads.
4. Product events of type `integration.gtasks_slack.mirrored` are appended on the connection owner’s most recently updated bot thread when one exists.

## Idempotency

- Unchanged replays are no-ops.
- Retries and concurrent workers rely on the `(workspaceId, lane, externalId)` unique key; a race on first create reconciles to a single Slack post.

## Configuration

Routing constants live in `packages/adapters/src/gtasks-slack-config.ts`. No OAuth, tokens, or live provider calls are required for unit tests; use the mocked port in `gtasks-slack-mirror.test.ts`.
