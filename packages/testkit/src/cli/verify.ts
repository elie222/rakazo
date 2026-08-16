import { execSync, spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { PostgreSqlContainer } from "@testcontainers/postgresql";

const providers = process.argv.includes("--providers");
const integrationOnly = process.argv.includes("--integration");
const webOnly = process.argv.includes("--web");

if (integrationOnly && webOnly) {
  throw new Error("Choose either --integration or --web, not both");
}

async function main() {
  const mode = integrationOnly ? "integration" : webOnly ? "web" : "full";
  const reportDir = path.resolve("verify-report", mode);
  await mkdir(reportDir, { recursive: true });
  const container = await new PostgreSqlContainer("postgres:16-alpine").start();
  try {
    const databaseUrl = container.getConnectionUri();
    const apiPort = Number(process.env.API_PORT ?? 3110);
    const webPort = Number(process.env.WEB_PORT ?? 5180);
    const webOrigin = `http://127.0.0.1:${webPort}`;

    process.env.DATABASE_URL = databaseUrl;
    process.env.VERIFY_DATABASE = "1";
    process.env.WAKEUP_DRIVER = "memory";
    process.env.SANDBOX_PROVIDER = "fake";
    process.env.AGENT_RUNTIME = "scripted";
    if (providers) {
      process.env.VERIFY_PROVIDERS = "1";
      if (process.env.E2B_API_KEY) process.env.SANDBOX_PROVIDER = "e2b";
      if (process.env.OPENROUTER_API_KEY) process.env.AGENT_RUNTIME = "pi";
    }
    process.env.BETTER_AUTH_SECRET = "verify-secret-verify-secret-32ch";
    process.env.ENCRYPTION_KEY = "verify-encryption-key-verify-encryption-key";
    process.env.BETTER_AUTH_URL = webOrigin;
    process.env.WEB_ORIGIN = webOrigin;
    process.env.API_PORT = String(apiPort);
    process.env.API_URL = `http://127.0.0.1:${apiPort}`;
    process.env.API_PROXY_TARGET = `http://127.0.0.1:${apiPort}`;
    process.env.WEB_PORT = String(webPort);
    process.env.PLAYWRIGHT_BASE_URL = webOrigin;
    process.env.DATA_DIR = path.join(reportDir, "data");
    process.env.SIGNUPS_ENABLED = "true";
    process.env.CI = "1";

    execSync("pnpm --filter @rakazo/db generate", { stdio: "inherit", env: process.env });
    execSync("pnpm --filter @rakazo/db exec prisma migrate deploy", {
      stdio: "inherit",
      env: process.env,
      cwd: path.resolve("packages/db"),
    });

    if (integrationOnly) {
      execSync(
        [
          "pnpm exec vitest run --no-file-parallelism",
          "packages/testkit/src/journeys.test.ts",
          "packages/testkit/src/authorization.test.ts",
          "packages/testkit/src/executor-lifecycle.test.ts",
          "packages/adapters/src/wakeup.postgres.test.ts",
          "packages/adapters/src/realtime.postgres.test.ts",
          "packages/adapters/src/job-reconciler.postgres.test.ts",
        ].join(" "),
        {
          stdio: "inherit",
          env: process.env,
        },
      );
      await writeSummary(reportDir, {
        ok: true,
        mode,
        providers,
        sandbox: process.env.SANDBOX_PROVIDER,
        runtime: process.env.AGENT_RUNTIME,
      });
      return;
    }

    if (!webOnly) {
      execSync("pnpm verify:fast", { stdio: "inherit", env: process.env });
    }

    const { createApp } = await import("../../../../apps/api/src/app.ts");
    const { serve } = await import("@hono/node-server");
    const handles = await createApp({ databaseUrl, prisma: undefined });
    const server = serve({ fetch: handles.app.fetch, port: apiPort, hostname: "127.0.0.1" });
    await waitForHealth(`http://127.0.0.1:${apiPort}/health`, 15_000);

    try {
      await run("pnpm", ["--filter", "@rakazo/web", "exec", "playwright", "test"], {
        ...process.env,
        CI: "1",
      });
      await writeSummary(reportDir, {
        ok: true,
        mode,
        providers,
        sandbox: process.env.SANDBOX_PROVIDER,
        runtime: process.env.AGENT_RUNTIME,
        apiPort,
        webPort,
      });
    } finally {
      server.close();
      await handles.stop().catch(() => undefined);
    }
  } finally {
    await container.stop().catch(() => undefined);
  }
}

async function writeSummary(reportDir: string, summary: Record<string, unknown>) {
  await writeFile(
    path.join(reportDir, "summary.json"),
    JSON.stringify({ ...summary, at: new Date().toISOString() }, null, 2),
  );
}

function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit", env, shell: false });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
  });
}

async function waitForHealth(url: string, ms: number) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < ms) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
      last = `${res.status}`;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`API health check failed for ${url}: ${last}`);
}

main().catch(async (error) => {
  console.error(error);
  process.exit(1);
});
