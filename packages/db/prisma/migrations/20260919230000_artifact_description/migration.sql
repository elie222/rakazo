-- Lets an artifact carry a human-readable one-line description alongside its
-- name, so the Artifacts tab can list what something is without opening it.
-- Nullable: existing artifacts (and any client that hasn't started sending it
-- yet) keep working unchanged.
ALTER TABLE "artifacts" ADD COLUMN "description" TEXT;
