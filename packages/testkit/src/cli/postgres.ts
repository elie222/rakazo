import { setTimeout as sleep } from "node:timers/promises";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

const ATTEMPTS = 4;

/**
 * Every database URL the app and Prisma read, pointed at one disposable database.
 * Prisma migrates DATABASE_MIGRATION_URL first and reloads `.env`, so an inherited
 * one must be overwritten, not deleted.
 */
export function disposableDatabaseEnv(url: string) {
  return { DATABASE_URL: url, DATABASE_MIGRATION_URL: url, REALTIME_DATABASE_URL: url };
}

/** A disposable Postgres; image registries rate-limit shared CI runners per minute, so pulls are retried. */
export async function startPostgres(signal?: AbortSignal) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      // A throwaway database needs no crash safety; parallel suites need more connections.
      return await new PostgreSqlContainer("postgres:18-alpine")
        .withCommand([
          "postgres",
          "-c",
          "fsync=off",
          "-c",
          "synchronous_commit=off",
          "-c",
          "full_page_writes=off",
          "-c",
          "max_connections=500",
        ])
        .start();
    } catch (error) {
      if (attempt === ATTEMPTS || signal?.aborted) throw error;
      const delaySeconds = attempt * 20;
      console.warn(`Postgres did not start (${String(error)}); retrying in ${delaySeconds}s`);
      await sleep(delaySeconds * 1000, undefined, { signal });
    }
  }
}
