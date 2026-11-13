-- Reads replay through current authorization instead of retaining decrypted content.
UPDATE external_effects
SET result = '{"ok": true}'::jsonb
WHERE kind IN ('read_history', 'search_history', 'list_secrets')
  AND status = 'completed'
  AND result IS NOT NULL
  AND result <> '{"ok": true}'::jsonb;
