import { execSync } from "node:child_process";
import path from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

async function main() {
  const runOpenRouter = Boolean(process.env.OPENROUTER_API_KEY);
  if (!process.env.E2B_API_KEY && !process.env.BOX_API_KEY && !runOpenRouter) {
    throw new Error(
      "E2B_API_KEY, BOX_API_KEY, or OPENROUTER_API_KEY is required for live provider canaries",
    );
  }

  const postgres = runOpenRouter
    ? await new PostgreSqlContainer("postgres:16-alpine").start()
    : undefined;
  try {
    const env = {
      ...process.env,
      ...(postgres ? { DATABASE_URL: postgres.getConnectionUri() } : {}),
      VERIFY_PROVIDERS: "1",
      BETTER_AUTH_SECRET: "provider-canary-auth-secret-at-least-32-characters",
      ENCRYPTION_KEY: "provider-canary-encryption-key-at-least-32-characters",
      SANDBOX_SUPERVISOR_TOKEN: "provider-canary-supervisor-token-at-least-32-characters",
      SCREEN_PROXY_SECRET: "provider-canary-screen-proxy-secret-at-least-32-characters",
      BETTER_AUTH_URL: "http://127.0.0.1:5173",
      WEB_ORIGIN: "http://127.0.0.1:5173",
      SIGNUPS_ENABLED: "true",
      SIGNUP_ALLOWLIST: "",
      DATA_DIR: path.resolve("test-report/canary/data"),
    };
    if (postgres) {
      execSync("pnpm --filter @rakazo/db generate", { stdio: "inherit", env });
      execSync("pnpm --filter @rakazo/db exec prisma migrate deploy", {
        stdio: "inherit",
        env,
        cwd: path.resolve("packages/db"),
      });
    }
    execSync(
      "pnpm exec vitest run --no-file-parallelism packages/testkit/src/providers.canary.test.ts packages/testkit/src/release-watch.canary.test.ts",
      { stdio: "inherit", env },
    );
  } finally {
    await postgres?.stop().catch(() => undefined);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
