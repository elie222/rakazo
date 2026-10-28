import { setTimeout as sleep } from "node:timers/promises";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

const ATTEMPTS = 4;

/** A disposable Postgres; image registries rate-limit shared CI runners per minute, so pulls are retried. */
export async function startPostgres(signal?: AbortSignal) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await new PostgreSqlContainer("postgres:18-alpine").start();
    } catch (error) {
      if (attempt === ATTEMPTS || signal?.aborted) throw error;
      const delaySeconds = attempt * 20;
      console.warn(`Postgres did not start (${String(error)}); retrying in ${delaySeconds}s`);
      await sleep(delaySeconds * 1000, undefined, { signal });
    }
  }
}
