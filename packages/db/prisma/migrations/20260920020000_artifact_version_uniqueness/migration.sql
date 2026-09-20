-- Enforces one row per (family, version) at the database level — the actual
-- correctness guarantee against two concurrent attachments resolving the
-- same next version number (the app retries on the resulting conflict; see
-- withResolvedArtifactVersion). Safe against existing data: a root row's own
-- id is already globally unique, so COALESCE(rootArtifactId, id) never
-- collides for existing single-version artifacts.
CREATE UNIQUE INDEX "artifacts_family_version_key"
  ON "artifacts" (COALESCE("rootArtifactId", "id"), "version");
