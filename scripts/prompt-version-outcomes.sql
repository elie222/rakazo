-- Outcome rates of finished runs by the prompt version they used, newest version first.
--   psql "$DATABASE_URL" -v days=7 -f scripts/prompt-version-outcomes.sql
-- Reads only run statuses and message block kinds, which stay plain when content is encrypted.
\if :{?days}
\else
\set days 7
\endif

WITH recent AS (
  SELECT id, status, "promptVersion", "createdAt"
  FROM runs
  WHERE "promptVersion" IS NOT NULL
    AND status IN ('completed', 'failed', 'cancelled')
    AND "createdAt" > now() - make_interval(days => :days)
),
blocks AS (
  SELECT
    m."runId",
    bool_or(b ->> 'kind' = 'steps') AS used_tools,
    bool_or(b ->> 'kind' = 'text') AS replied,
    count(*) FILTER (WHERE b ->> 'kind' = 'ask') AS asks
  FROM messages m
  JOIN recent r ON r.id = m."runId"
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(m.blocks) = 'array' THEN m.blocks ELSE '[]'::jsonb END
  ) b
  WHERE m.role = 'bot'
  GROUP BY m."runId"
)
SELECT
  r."promptVersion" AS version,
  min(r."createdAt")::date AS first_seen,
  count(*) AS runs,
  round(100.0 * avg((r.status = 'failed')::int), 1) AS failed_pct,
  round(100.0 * avg((r.status = 'cancelled')::int), 1) AS cancelled_pct,
  -- Finished after tool work without a single text block in its replies.
  round(
    100.0 * avg((r.status = 'completed' AND coalesce(b.used_tools, false)
      AND NOT coalesce(b.replied, false))::int),
    1
  ) AS tools_no_reply_pct,
  -- Approval and question cards the run showed the user.
  round(100.0 * avg((coalesce(b.asks, 0) > 0)::int), 1) AS asked_pct,
  round(avg(coalesce(b.asks, 0)), 2) AS asks_per_run
FROM recent r
LEFT JOIN blocks b ON b."runId" = r.id
GROUP BY r."promptVersion"
ORDER BY first_seen DESC, runs DESC;
