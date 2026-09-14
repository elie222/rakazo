import { PrismaPg } from "@prisma/adapter-pg";
import type { PoolClient } from "pg";
import { Pool } from "pg";
import { PrismaClient } from "./generated/prisma/client.js";

export type Db = PrismaClient;

export interface DbClientOptions {
  poolMax?: number;
  applicationName?: string;
}

const DEFAULT_POOL_MAX = 4;
const CONNECT_RETRY_ATTEMPTS = 8;

export function createPool(connectionString: string, options: DbClientOptions = {}): Pool {
  const pool = new Pool({
    connectionString,
    max: options.poolMax ?? DEFAULT_POOL_MAX,
    // Fail a checkout instead of queueing forever when Postgres is already at
    // max_connections (53300) or the pool is saturated.
    connectionTimeoutMillis: 10_000,
    // 0 disables idle eviction. Dropping idle clients and reopening them on the
    // next job burst is how a tight Postgres hits 53300; keep what we already have.
    idleTimeoutMillis: 0,
    application_name: options.applicationName,
    keepAlive: true,
  });
  // graphile-worker (and Node itself) require an 'error' listener on a shared
  // pool: an idle-client disconnect is otherwise an unhandled error that kills
  // the process and orphans the TCP sessions until Postgres times them out.
  pool.on("error", () => undefined);
  pool.on("connect", (client) => {
    client.on("error", () => undefined);
  });
  installConnectRetry(pool);
  return pool;
}

export function createDb(
  connectionString: string,
  options: DbClientOptions = {},
): { prisma: PrismaClient; pool: Pool } {
  const pool = createPool(connectionString, options);
  const adapter = new PrismaPg(pool);
  const prisma = new PrismaClient({ adapter });
  return { prisma, pool };
}

export function isTooManyDatabaseConnections(error: unknown): boolean {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    const code = "code" in current ? current.code : undefined;
    if (code === "P2037" || code === "53300") return true;
    const message = current instanceof Error ? current.message : String(current);
    if (
      message.includes("Too many database connections opened") ||
      message.includes("sorry, too many clients already")
    ) {
      return true;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return false;
}

export async function retryOnTooManyConnections<T>(
  operation: () => Promise<T>,
  options: {
    attempts?: number;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<T> {
  const attempts = options.attempts ?? CONNECT_RETRY_ATTEMPTS;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (!isTooManyDatabaseConnections(error) || attempt >= attempts - 1) throw error;
      await sleep(Math.min(5_000, 200 * 2 ** attempt));
    }
  }
}

function installConnectRetry(pool: Pool): void {
  type ConnectCallback = (
    err: Error,
    client: PoolClient,
    done: (release?: boolean) => void,
  ) => void;
  const originalConnect = pool.connect.bind(pool) as {
    (): Promise<PoolClient>;
    (callback: ConnectCallback): void;
  };

  function connect(): Promise<PoolClient>;
  function connect(callback: ConnectCallback): void;
  function connect(callback?: ConnectCallback): Promise<PoolClient> | undefined {
    if (!callback) return retryOnTooManyConnections(() => originalConnect());
    const attempt = (n: number) => {
      originalConnect((err, client, done) => {
        if (err && isTooManyDatabaseConnections(err) && n < CONNECT_RETRY_ATTEMPTS - 1) {
          setTimeout(() => attempt(n + 1), Math.min(5_000, 200 * 2 ** n));
          return;
        }
        callback(err, client, done);
      });
    };
    attempt(0);
  }

  pool.connect = connect as Pool["connect"];
}

export function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export type { Pool } from "pg";
export * from "./generated/prisma/client.js";
export { Prisma, PrismaClient } from "./generated/prisma/client.js";
