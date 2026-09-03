import { execSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadRootEnv } from "@rakazo/core/node/load-root-env";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { runProcess } from "./process.js";

loadRootEnv();

const integration = process.argv.includes("--integration");
const e2e = process.argv.includes("--e2e");
const sandboxArg = process.argv.find((arg) => arg.startsWith("--sandbox="));
const specArg = process.argv.find((arg) => arg.startsWith("--spec="));
const grepArg = process.argv.find((arg) => arg.startsWith("--grep="));
const runtimeArg = process.argv.find((arg) => arg.startsWith("--runtime="));
const sandboxProvider = sandboxArg?.slice("--sandbox=".length) ?? "fake";
const e2eSpec = specArg?.slice("--spec=".length);
const e2eGrep = grepArg?.slice("--grep=".length);
const agentRuntime = runtimeArg?.slice("--runtime=".length) ?? "scripted";

if (Number(integration) + Number(e2e) !== 1) {
  throw new Error("Pass exactly one of --integration or --e2e");
}
if (!["fake", "e2b", "daytona", "box"].includes(sandboxProvider)) {
  throw new Error('Sandbox must be "fake", "e2b", "daytona", or "box"');
}
if (integration && sandboxProvider !== "fake") {
  throw new Error("Integration tests only support the fake sandbox");
}
if (agentRuntime !== "pi" && agentRuntime !== "scripted") {
  throw new Error('Runtime must be "pi" or "scripted"');
}
if (sandboxProvider === "e2b" && !process.env.E2B_API_KEY) {
  throw new Error("E2B_API_KEY is required when --sandbox=e2b");
}
if (sandboxProvider === "daytona" && !process.env.DAYTONA_API_KEY) {
  throw new Error("DAYTONA_API_KEY is required when --sandbox=daytona");
}
if (sandboxProvider === "box" && !process.env.BOX_API_KEY) {
  throw new Error("BOX_API_KEY is required when --sandbox=box");
}

async function main() {
  const mode = integration ? "integration" : "e2e";
  const reportDir = path.resolve("test-report", mode);
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
    process.env.SANDBOX_PROVIDER = sandboxProvider;
    process.env.AGENT_RUNTIME = agentRuntime;
    process.env.COMPOSIO_API_KEY = "";
    process.env.BETTER_AUTH_SECRET = "test-secret-test-secret-32chars!";
    process.env.ENCRYPTION_KEY = "test-encryption-key-test-encryption-key";
    process.env.SANDBOX_SUPERVISOR_TOKEN = "test-supervisor-token-test-32chars";
    process.env.SCREEN_PROXY_SECRET = "test-screen-proxy-secret-test-32chars";
    process.env.BETTER_AUTH_URL = webOrigin;
    process.env.WEB_ORIGIN = webOrigin;
    process.env.API_PORT = String(apiPort);
    process.env.API_URL = `http://127.0.0.1:${apiPort}`;
    process.env.API_PROXY_TARGET = `http://127.0.0.1:${apiPort}`;
    process.env.WEB_PORT = String(webPort);
    process.env.PLAYWRIGHT_BASE_URL = webOrigin;
    process.env.DATA_DIR = path.join(reportDir, "data");
    process.env.SIGNUPS_ENABLED = "true";
    process.env.SIGNUP_ALLOWLIST = "";
    process.env.CI = "1";

    execSync("pnpm --filter @rakazo/db generate", { stdio: "inherit", env: process.env });
    execSync("pnpm --filter @rakazo/db exec prisma migrate deploy", {
      stdio: "inherit",
      env: process.env,
      cwd: path.resolve("packages/db"),
    });

    if (integration) {
      execSync(
        [
          "pnpm exec vitest run --no-file-parallelism",
          "packages/testkit/src/journeys.test.ts",
          "packages/testkit/src/authorization.test.ts",
          "packages/testkit/src/attachments.test.ts",
          "packages/testkit/src/voice.test.ts",
          "packages/testkit/src/search.test.ts",
          "packages/testkit/src/executor-lifecycle.test.ts",
          "packages/testkit/src/connections.test.ts",
          "packages/db/src/space-membership.postgres.test.ts",
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
        sandbox: process.env.SANDBOX_PROVIDER,
        runtime: process.env.AGENT_RUNTIME,
      });
      return;
    }

    const [
      { ComposioEmulator, EmailEmulator, PipedreamConnector, ThirdPartyConnectorEmulator },
      { createApp },
    ] = await Promise.all([import("@rakazo/adapters"), import("../../../../apps/api/src/app.ts")]);
    const { serve } = await import("@hono/node-server");
    const thirdParties = new ThirdPartyConnectorEmulator();
    const pipedream = new PipedreamConnector(
      {
        clientId: "fake-client-id",
        clientSecret: "fake-client-secret",
        projectId: "fake-project-id",
        environment: "development",
        identitySecret: process.env.ENCRYPTION_KEY,
      },
      { fetch: thirdParties.fetch, resolveHostname: thirdParties.resolveHostname },
    );
    const email = new EmailEmulator();
    const handles = await createApp({
      databaseUrl,
      prisma: undefined,
      composio: new ComposioEmulator(),
      pipedream,
      email,
      remoteConnectors: {
        fetch: thirdParties.fetch,
        resolveHostname: thirdParties.resolveHostname,
      },
    });
    let activeRequests = 0;
    const requestWaiters = new Set<() => void>();
    const server = serve({
      fetch: async (request) => {
        if (new URL(request.url).pathname === "/__e2e/emails") {
          return Response.json(email.sent, { headers: { "cache-control": "no-store" } });
        }
        activeRequests += 1;
        try {
          return await handles.app.fetch(request);
        } finally {
          activeRequests -= 1;
          if (activeRequests === 0) {
            for (const resolve of requestWaiters) resolve();
            requestWaiters.clear();
          }
        }
      },
      port: apiPort,
      hostname: "127.0.0.1",
    });
    await waitForHealth(`http://127.0.0.1:${apiPort}/health`, 15_000);

    try {
      try {
        await runProcess(
          "pnpm",
          [
            "--filter",
            "@rakazo/web",
            "exec",
            "playwright",
            "test",
            ...(e2eSpec ? [e2eSpec] : []),
            ...(e2eGrep ? ["--grep", e2eGrep] : []),
          ],
          {
            ...process.env,
            CI: "1",
            // Pin English so e2e selectors match source messages regardless of runner locale.
            VITE_DEFAULT_UI_LOCALE: "en",
          },
        );
      } catch (error) {
        const failedRuns = await handles.prisma.run.findMany({
          where: { status: "failed" },
          select: { id: true, error: true },
        });
        if (failedRuns.length) console.error("Failed agent runs:", failedRuns);
        throw error;
      }
      await writeSummary(reportDir, {
        ok: true,
        mode,
        sandbox: process.env.SANDBOX_PROVIDER,
        runtime: process.env.AGENT_RUNTIME,
        apiPort,
        webPort,
      });
    } finally {
      const cleanupErrors: unknown[] = [];
      const computers = await managedComputers(handles).catch((error) => {
        cleanupErrors.push(error);
        return [];
      });
      await new Promise<void>((resolve) => server.close(() => resolve()));
      if (activeRequests > 0) {
        await new Promise<void>((resolve) => requestWaiters.add(resolve));
      }
      await handles.stop().catch(() => undefined);
      for (let index = 0; index < computers.length; index += 4) {
        const results = await Promise.allSettled(
          computers.slice(index, index + 4).map((computer) =>
            handles.sandbox.destroy(
              {
                id: computer.providerRef!,
                botId: computer.homeKey,
                kind: computer.kind as "e2b" | "daytona" | "box",
                providerRef: computer.providerRef!,
              },
              {
                operationId: "e2e-cleanup",
                traceId: "e2e-cleanup",
                spaceId: computer.spaceId,
                userId: computer.userId,
                signal: new AbortController().signal,
              },
            ),
          ),
        );
        for (const result of results) {
          if (result.status === "rejected") cleanupErrors.push(result.reason);
        }
      }
      if (cleanupErrors.length) {
        console.error(
          new AggregateError(cleanupErrors, "Could not destroy every managed test sandbox"),
        );
        process.exitCode = 1;
      }
    }
  } finally {
    await container.stop().catch(() => undefined);
  }
}

type AppHandles = Awaited<
  ReturnType<typeof import("../../../../apps/api/src/app.ts")["createApp"]>
>;

async function managedComputers(handles: AppHandles) {
  if (!["e2b", "daytona", "box"].includes(sandboxProvider)) return [];
  return handles.prisma.computer.findMany({
    where: { providerRef: { not: null } },
    select: { homeKey: true, kind: true, providerRef: true, userId: true, spaceId: true },
  });
}

async function writeSummary(reportDir: string, summary: Record<string, unknown>) {
  await writeFile(
    path.join(reportDir, "summary.json"),
    JSON.stringify({ ...summary, at: new Date().toISOString() }, null, 2),
  );
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

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
