# Logs and monitoring

Collect logs, errors, traces and product analytics, and alert on security events and host
problems.

## Logging

Backend services write structured logs to stdout. `LOG_LEVEL` is `debug`, `info`, `warn`, `error`,
or `off` (default `info`). Production defaults to `LOG_FORMAT=json`; development defaults to pretty
unless you set `json` or `pretty`.

Axiom is optional. Set both `AXIOM_TOKEN` and `AXIOM_DATASET` for ingest to one shared dataset.
Services set `service.name` (`rakazo-api`, `rakazo-worker`, `rakazo-sandbox-supervisor`,
`rakazo-updater`). A partial Axiom config logs a one-time warning and stays off. `AXIOM_EDGE` is a
regional hostname; `AXIOM_EDGE_URL` must be https and wins when both are set.

## Computer usage events

Computer usage is recorded at several boundaries:

- `run.computer`: one record per execution attempt, including runs that never request a computer
  (`reason=none`). `reason` is `tool`, `takeover`, or `script` otherwise; `tool` is an allowlisted
  built-in name and `trigger` identifies user, routine, or other run sources. Deduplicate `run.id`
  when counting runs, because a run can have several attempts.
- `computer.requested`: the first computer use in an attempt, with its reason, tool, and trigger.
- `computer.provisioned`: completed setup, with `operation=create`, `resume`, or `reuse` and
  `durationMs`. A setup request can reuse an already-running computer without spending a start.
- `sandbox.start`: Boat's actual `create`, `resume`, and `recover` requests, including starts during
  preparation or after the provider expires a computer. `outcome=accepted` means the provider
  accepted the request, not that all later setup succeeded. `rate_limited` and `failed` are
  separate outcomes. Count accepted creates/resumes for start usage; recoveries are shown separately
  because their quota treatment depends on the provider.
- `computer.suspended`: successful idle or active-limit suspension, with the active duration.

These records use fixed metadata, opaque correlation IDs, durations, and booleans. They do not add
prompts, responses, filenames, file contents, command arguments, or credentials. Request/job trace
fields link non-run starts back to the API route or background job that initiated them. Axiom is
an additional sink for the same logs; these events need no extra keys when ingest is configured.

For example, substitute your own dataset in these APL queries:

```apl
['YOUR_DATASET']
| where message == 'sandbox.start'
| summarize requests=count() by provider, operation, outcome
```

```apl
['YOUR_DATASET']
| where message == 'computer.requested'
| summarize requests=count() by trigger, reason, tool
```

```apl
['YOUR_DATASET']
| where message == 'run.computer'
| summarize attempts=count(), withoutComputer=countif(reason == 'none') by trigger
```

Track accepted starts per hour/day, rate-limit refusals, first-use tools, and the proportion of
attempts needing no computer before tuning `SANDBOX_IDLE_MS`. Increasing the idle window reduces
resumes between nearby uses but increases billed runtime; changing it does not remove unnecessary
starts caused by tools. Provider rolling-window limits remain the source of truth for quota.

## Error reporting

Error reporting to Sentry or a Sentry-compatible collector such as GlitchTip is optional:

- `SENTRY_DSN` reports backend `error` logs, with the exception chain, `service`, and request or job
  ids as tags. Uncaught exceptions are reported before exit.
- `SENTRY_BROWSER_DSN` reports web app errors. The browser reads it from `/api/monitoring/config` at
  startup and posts reports to `/api/monitoring/tunnel`; the API forwards only envelopes addressed
  to that DSN. Use a separate project from `SENTRY_DSN`.
- `SENTRY_ENVIRONMENT` names the deployment. `SENTRY_RELEASE` defaults to the image's `GIT_SHA`.

Desktop and mobile use the connected server's `SENTRY_BROWSER_DSN`. Electron sends crash metadata
without memory dumps. Mobile native reporting requires a rebuilt app; Expo Go is unsupported.
For readable mobile crash stacks, build with `SENTRY_AUTH_TOKEN`, `SENTRY_ORG`, `SENTRY_PROJECT`,
and optional `SENTRY_URL` to upload symbols.

Neither SDK sends cookies, headers, request bodies, user identity, console output, or log context.
When `ANALYTICS_PSEUDONYM_SECRET` is set, reports carry a keyed hash of the signed-in user's id so
the collector can count affected users; the raw id, email and IP address are never sent, and the
browser receives its hash from the API. Reporting is off without a DSN; an invalid DSN logs a
warning and stays off.

Compose passes these into the API, worker, supervisor, and updater. Computer containers and updater
child commands do not receive them.

## Tracing

Set `OTEL_EXPORTER_OTLP_ENDPOINT` on the worker to enable optional OpenTelemetry traces
(for example, `http://otel-collector:4318`). The OTLP/HTTP exporter appends `/v1/traces`
to the base endpoint and honors standard `OTEL_EXPORTER_OTLP_HEADERS` (comma-separated
`key=value` pairs) and `OTEL_SERVICE_NAME` (default `rakazo-worker`). Compose workers
read these settings from `.env`. With an empty or unset endpoint, no tracing SDK loads
or initializes. No collector or hosted service is required to run Rakazo.

Traces contain a `rakazo.agent.run` span with `pi.ai.request` model-call spans and
`pi.agent.tool` steps, including duration, token usage, cost when known, and success/error
status. Each span carries `rakazo.bot.id`, `rakazo.run.id`, and `rakazo.routine.id`
when the run belongs to a routine. Helper model calls inherit the same correlation.
Pi 0.87.1 exposes built-in telemetry through its newer harness; Rakazo’s legacy Agent
adapter maps its model and tool lifecycle through the same Pi telemetry contract.

Prompt, response, tool arguments and tool results are excluded by default.
`OTEL_CAPTURE_CONTENT=true` includes them: enable only with a trusted collector and
appropriate retention/access controls, since this content can contain secrets or personal
data. Unknown attributes and exception messages/stacks stay excluded. Export is batched,
best effort, and flushed when the worker shuts down; collector failures do not fail runs.

The standard `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and `OTEL_EXPORTER_OTLP_TRACES_HEADERS` are
also passed through, for a collector that takes traces at a different address.

## Product analytics

Product analytics is off by default. To enable the PostHog adapter, set
`ANALYTICS_PROVIDER=posthog`, `ANALYTICS_KEY` to a project capture token, and
`ANALYTICS_HOST` to the HTTPS ingestion host (default `https://us.i.posthog.com`)
on API and worker. Also set `ANALYTICS_PSEUDONYM_SECRET` to a server-only random
value (`openssl rand -hex 32`), identical on API and worker. Retain it when rotating
the public capture token so user and event identities stay stable. Never send this
secret to the browser or collector. Set `ANALYTICS_PROVIDER=none` to disable it.
The public website uses its separate `PUBLIC_POSTHOG_KEY` configuration.

The backend sends account creation, session creation, fixed screen names, message
counts, and run starts/outcomes. Run events include the shared trigger enum;
analytics does not read or classify error text. User identifiers are pseudonymized
with the server-only secret. No names,
emails, prompts, responses, message text, DOM, URLs, search parameters, document
contents, request metadata, or raw errors are exported. There is no browser or
mobile analytics SDK, autocapture, session replay, or third-party script.
Web, Electron, and mobile send only fixed screen/surface enums to the authenticated
API; lifecycle events come from the shared backend. This works across clients
without giving a collector access to their content. Local and self-hosted
installations remain off until their backend is configured.

Delivery is best effort: memory is bounded, requests time out, and shutdown flushes
pending events. Analytics failure does not fail product operations. This is not a
durable audit trail, and events from before enablement are not backfilled.

## Security events

The API and worker append a row to `security_events` and write a `security.event` log line for:

- sign-up, sign-in, sign-out, and failed sign-in or sign-up
- session revocation, password and passkey changes, and account deletion
- model, MCP, connector, voice, memory, and secret credentials created, changed, or removed
- deployment settings changes, approval decisions, and approval policy changes
- refused private or internal destinations (`egress.refused`) and auth rate-limit hits

Each event has the user, space, client address, user agent, time, and a few identifiers. Events
never include message content, secrets, or tokens. Rows older than `SECURITY_EVENT_RETENTION_DAYS`
(default 90) are deleted, and Postgres rejects updates to the rows that remain.
An account's own events are also written to its organization's [audit log](./self-host-audit-log.md).

Operators read recent events through server-side database/log tooling. For example, query Postgres:

```bash
docker compose --env-file .env -f infra/compose/docker-compose.prod.yml exec postgres \
  psql -U rakazo -d rakazo -c 'SELECT "createdAt", type, ip, "userId", "userAgent", metadata
  FROM security_events ORDER BY "createdAt" DESC LIMIT 50'
```

Caddy writes a JSON access-log line for each request to stdout. The lines exclude
`Authorization`, `Cookie`, and `Set-Cookie`, and URL tokens are replaced with `REDACTED`. Docker
rotates container logs and drops them when it recreates a container. To keep Caddy's lines, ship
container stdout to your log sink with a collector. Security events reach the sink through the
API's own log shipping, and Postgres keeps them too.

## What to alert on

The queries below are pseudo-SQL over the JSON log lines, so translate them to your log sink. Field
names are the literal keys in each line: `message`, `security.event.type`, `client.ip`,
`user_agent.original`, `user.id`, and the `security.event.metadata` object. Tune the thresholds to
your traffic.

Sign-up bursts from one address:

```sql
SELECT "client.ip", count(*) FROM logs
WHERE message = 'security.event' AND "security.event.type" = 'auth.sign_up'
GROUP BY "client.ip", bucket(1 hour) HAVING count(*) > 3
```

Password guessing, from one address and across many:

```sql
SELECT "client.ip", count(*) FROM logs
WHERE "security.event.type" IN ('auth.sign_in.failed', 'rate_limit.hit')
GROUP BY "client.ip", bucket(15 minutes) HAVING count(*) > 10;

SELECT count(DISTINCT "client.ip") FROM logs
WHERE "security.event.type" = 'auth.sign_in.failed'
GROUP BY bucket(15 minutes) HAVING count(*) > 50
```

Probes of internal addresses. Any hit deserves a look:

```sql
SELECT "user.id", "security.event.metadata.host", "security.event.metadata.reason", count(*)
FROM logs WHERE "security.event.type" = 'egress.refused'
GROUP BY 1, 2, 3
```

Scripted clients on account routes:

```sql
SELECT "client.ip", "user_agent.original", count(*) FROM logs
WHERE "security.event.type" LIKE 'auth.%'
  AND ("user_agent.original" IS NULL
    OR lower("user_agent.original") SIMILAR TO '%(curl|wget|python|go-http-client|headless|okhttp|java/)%')
GROUP BY 1, 2
```

Credential and settings changes from an address that user has not signed in from:

```sql
SELECT * FROM logs c
WHERE (c."security.event.type" LIKE 'credential.%'
    OR c."security.event.type" = 'deployment.settings.changed')
  AND NOT EXISTS (SELECT 1 FROM logs s WHERE s."security.event.type" = 'auth.sign_in'
    AND s."user.id" = c."user.id" AND s."client.ip" = c."client.ip")
```

## Host checks and alerts

Monitoring is opt-in. Install `host-alert.py` as `/usr/local/sbin/rakazo-host-alert` and
`check-host.sh` as `/usr/local/sbin/rakazo-host-check`, and `check-services.py` as
`/usr/local/sbin/rakazo-check-services` (all executable), then install the supplied host-check service
and timer and enable `rakazo-host-check.timer`. Checks run every five minutes and report low disk
space, failed backups, a verified backup older than 36 hours, or missing configured IPv4 SSH rules.
To also check API and worker containers, set `RAKAZO_MONITOR_COMPOSE_PROJECT` in `backup.env` to
the Compose project name (`rakazo-prod` for production). The worker probe checks heartbeat and
reconciliation freshness. Leave the variable unset if container monitoring is managed elsewhere.

The dedicated-volume check is enabled only by `RAKAZO_BACKUP_REQUIRE_VOLUME=1` in `backup.env`.
Identical alerts are suppressed for a day; recovery sends a separate notification.

Alerts go to the system journal by default; no external service is required. For optional Slack
delivery, create a root-only `/etc/rakazo/alerts.json` containing
`{"slack_webhook":"https://hooks.slack.com/services/REPLACE/ME/SECRET"}`. Never commit this file.
To notify immediately on backup failure, also install `rakazo-backup-alert.service` and copy
`infra/systemd/rakazo-backup-alerts.conf.example` to
`/etc/systemd/system/rakazo-backup.service.d/alerts.conf`. Run `systemctl daemon-reload` after
installing units or drop-ins. The base backup service does not require the monitoring tools.

## Host audit trail

`harden-host.sh` installs audit rules for writes to SSH keys, sudoers, accounts, `/etc/rakazo`, the
deployment's `.env`, `/usr/local/sbin`, systemd units, cron, and the Docker daemon config. A rule
whose directory does not exist yet, such as the `.env` before the first clone, is skipped with a
notice; rerun the script once it exists. Anyone with root can wipe local logs, so the record only
helps once it has left the host.

To ship it, create a root-only `/etc/rakazo/audit-ship.env` and put the sink's token in
`/etc/rakazo/audit-ship.token`, then rerun `harden-host.sh`. Only then does it install `audit-ship.py`
as `/usr/local/sbin/rakazo-audit-ship` and enable `rakazo-audit-ship.service`. The sink is any HTTPS
endpoint that accepts a JSON array of events with a bearer token, for example Axiom's
`https://api.axiom.co/v1/datasets/<dataset>/ingest`.

```env
RAKAZO_AUDIT_SINK_URL=https://ingest.example.com/v1/events
# Optional: name the SSH keys you expect (fingerprints from `ssh-keygen -lf key.pub`).
RAKAZO_AUDIT_KNOWN_KEYS=SHA256:replace-with-fingerprint=laptop SHA256:replace-with-fingerprint=ci
# Optional: RAKAZO_AUDIT_TOKEN_FILE (default /etc/rakazo/audit-ship.token), RAKAZO_AUDIT_HOST
# (default: the hostname), and RAKAZO_AUDIT_HEARTBEAT_SECONDS (default 10800, three hours).
```

Use a token that can only write to that one destination, so a compromised host cannot read or delete
what it already sent. The shipper follows `/var/log/auth.log` and the audit log and sends `ssh.login`
(with `key_name`, `unknown` for keys not listed), `ssh.failed`, `sudo.command`, `su`,
`identity.change`, and `file.change` (with the rule's `watch` key and the changed `paths`), plus a
`shipper.heartbeat` on start and every `RAKAZO_AUDIT_HEARTBEAT_SECONDS`. Every
event carries `event`, `host`, `source`, `message`, and `_time`. Offsets advance only after the sink
accepts a batch, and failures retry with backoff, so events arrive at least once. On first start it
ships the current auth log and starts the audit log at its end. With monitoring installed, the host
check alerts when a sink is configured but the shipper is not running.

Alert in the destination, not on the host. Starting points, written as Axiom APL here but plain
filters in any log store:

| Alert | Query |
| --- | --- |
| Login with an unnamed key | `where event == "ssh.login" and key_name == "unknown"` |
| Watched file changed | `where event == "file.change"` outside your own deploys and maintenance |
| Root use outside the deploy account | `where (event == "sudo.command" and user != "deploy") or event == "su" or event == "identity.change"` |
| Shipping stopped | no `shipper.heartbeat` from a `host` for more than two heartbeat intervals |
