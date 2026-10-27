import { execFileSync, spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import {
  ComposioConnector,
  EmailEmulator,
  FakeComposioClient,
  PipedreamConnector,
  ThirdPartyConnectorEmulator,
} from "@rakazo/adapters";
import { createApp } from "@rakazo/api/app";
import { PostgreSqlContainer } from "@testcontainers/postgresql";
import { createScreenshotModelQuotaFetch } from "../model-quota-screenshot-fixture.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");
const API_URL = requiredEnv("RAKAZO_API_URL").replace(/\/$/, "");
const api = new URL(API_URL);
if (api.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(api.hostname)) {
  throw new Error(
    "RAKAZO_API_URL must be a local HTTP URL that matches the installed simulator app",
  );
}
if (!api.port) throw new Error("RAKAZO_API_URL must include the simulator app's API port");
const port = Number(api.port);
await assertPortFree(port);
const dataDir = path.join("/tmp", `rakazo-ios-usage-${process.pid}`);
const postgres = await new PostgreSqlContainer("postgres:18-alpine").start();
Object.assign(process.env, {
  NODE_ENV: "test",
  WAKEUP_DRIVER: "memory",
  SANDBOX_PROVIDER: "fake",
  AGENT_RUNTIME: "scripted",
  COMPOSIO_API_KEY: "",
  BETTER_AUTH_SECRET: "ios-usage-screenshot-auth-secret-32chars",
  ENCRYPTION_KEY: "ios-usage-screenshot-encryption-key-32chars",
  SCREEN_PROXY_SECRET: "ios-usage-screenshot-screen-secret-32chars",
  BETTER_AUTH_URL: API_URL,
  WEB_ORIGIN: "http://127.0.0.1:5180",
  API_HOST: "0.0.0.0",
  API_PORT: String(port),
  API_URL,
  DATA_DIR: dataDir,
  SIGNUPS_ENABLED: "true",
  SIGNUP_ALLOWLIST: "",
  CI: "1",
  DATABASE_URL: postgres.getConnectionUri(),
  IOS_SCREENSHOT_MODEL_QUOTA_FIXTURE: "true",
});

await mkdir(dataDir, { recursive: true });
try {
  execFileSync("pnpm", ["--filter", "@rakazo/db", "exec", "prisma", "migrate", "deploy"], {
    cwd: path.join(ROOT, "packages", "db"),
    env: process.env,
    stdio: "inherit",
  });
  const thirdParties = new ThirdPartyConnectorEmulator();
  const pipedream = new PipedreamConnector(
    {
      clientId: "fake-client-id",
      clientSecret: "fake-client-secret",
      projectId: "fake-project-id",
      environment: "development",
      identitySecret: process.env.ENCRYPTION_KEY!,
    },
    { fetch: thirdParties.fetch, resolveHostname: thirdParties.resolveHostname },
  );
  const handles = await createApp({
    databaseUrl: process.env.DATABASE_URL!,
    dataDir,
    apiHost: "0.0.0.0",
    apiUrl: API_URL,
    composio: new ComposioConnector({ client: new FakeComposioClient() }),
    pipedream,
    email: new EmailEmulator(),
    modelQuotaFetch: createScreenshotModelQuotaFetch(),
    remoteConnectors: {
      fetch: thirdParties.fetch,
      resolveHostname: thirdParties.resolveHostname,
    },
  });
  const server = serve({ fetch: handles.app.fetch, hostname: "0.0.0.0", port });
  try {
    await waitForHealth(`${API_URL}/health`);
    const child = spawn("pnpm", ["ios:screenshots", "--", "--section", "usage"], {
      stdio: "inherit",
      env: process.env,
    });
    const code = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (value) => resolve(value ?? 1));
    });
    if (code !== 0) throw new Error(`iOS Usage screenshot flow exited ${code}`);
  } finally {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeAllConnections();
    });
    await handles.stop().catch(() => undefined);
  }
} finally {
  await rm(dataDir, { recursive: true, force: true });
  await postgres.stop();
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

async function waitForHealth(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw new Error("The disposable iOS screenshot API did not become healthy");
}

async function assertPortFree(value: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => reject(new Error(`Port ${value} is already in use`)));
    server.listen(value, "127.0.0.1", () =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  });
}
