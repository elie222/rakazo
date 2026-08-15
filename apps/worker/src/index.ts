import { existsSync } from "node:fs";
import path from "node:path";
import type { JobPublisher, JobWorkerHost } from "@rakazo/adapter-kit";
import { config } from "dotenv";

function loadRootEnv() {
  let dir = process.cwd();
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, ".env");
    if (existsSync(candidate)) {
      config({ path: candidate, override: false });
      if (process.env.DATA_DIR && !path.isAbsolute(process.env.DATA_DIR)) {
        process.env.DATA_DIR = path.resolve(dir, process.env.DATA_DIR);
      }
      return;
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  config();
}
loadRootEnv();

import {
  createBackgroundJobHandlers,
  createConnectorStack,
  createJobReconciler,
  createRunExecutor,
  createRunSandbox,
  EncryptedSecretStore,
  ExpoPushProvider,
  GraphileJobPublisher,
  GraphileJobWorkerHost,
  InMemoryJobQueue,
  isComposioEnabled,
  LocalAgentHomeStore,
  PiAgentRuntime,
  PostgresRealtimeFanout,
  ScriptedAgentRuntime,
} from "@rakazo/adapters";
import { resolveEncryptionKey } from "@rakazo/core";
import { createDb, createThreadEvents } from "@rakazo/db";
import { MarkdownMemoryStore } from "@rakazo/memory";

async function main() {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required");
  const { prisma, pool } = createDb(databaseUrl);
  const realtime = new PostgresRealtimeFanout({
    connectionString: process.env.REALTIME_DATABASE_URL ?? databaseUrl,
    publisher: pool,
  });
  const events = createThreadEvents(prisma, realtime);
  const runtime =
    process.env.AGENT_RUNTIME === "scripted" ? new ScriptedAgentRuntime() : new PiAgentRuntime();
  const dataDir = process.env.DATA_DIR ?? "./data";
  const sandbox = createRunSandbox(process.env.SANDBOX_PROVIDER ?? "docker", {
    supervisorUrl: process.env.SANDBOX_SUPERVISOR_URL ?? "http://127.0.0.1:7091",
    e2bApiKey: process.env.E2B_API_KEY,
    dataDir,
    prisma,
  });
  const stack = createConnectorStack(isComposioEnabled(process.env.COMPOSIO_API_KEY));
  const connector = stack.destination;
  await connector.start();
  const secrets = new EncryptedSecretStore(resolveEncryptionKey(process.env));
  const home = new LocalAgentHomeStore(dataDir);
  const inMemoryJobs = process.env.WAKEUP_DRIVER === "memory" ? new InMemoryJobQueue() : undefined;
  const jobs: JobPublisher = inMemoryJobs ?? new GraphileJobPublisher(databaseUrl);
  const jobHost: JobWorkerHost = inMemoryJobs ?? new GraphileJobWorkerHost(databaseUrl);
  const executor = createRunExecutor({
    prisma,
    runtime,
    sandbox,
    memory: new MarkdownMemoryStore(prisma),
    home,
    connector: stack.connector,
    secrets: [process.env.OPENROUTER_API_KEY ?? "", process.env.COMPOSIO_API_KEY ?? ""].filter(
      Boolean,
    ),
    secretStore: secrets,
    deploymentModelKey: process.env.OPENROUTER_API_KEY,
    dataDir,
    notifications: new ExpoPushProvider(dataDir),
    jobs,
    events,
  });

  const jobHandlers = createBackgroundJobHandlers({
    executor,
    prisma,
    sandbox,
    home,
    jobs,
    events,
    workerId: process.pid.toString(),
  });
  await jobHost.start(jobHandlers);
  const reconciler = createJobReconciler({ prisma, jobs });
  reconciler.start();

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    await reconciler.stop();
    await jobHost.stop();
    await jobs.close();
    await realtime.close();
    await connector.stop();
    await prisma.$disconnect().catch(() => undefined);
    await pool.end().catch(() => undefined);
  };
  process.once("SIGTERM", () => void stop());
  process.once("SIGINT", () => void stop());

  console.log("rakazo worker ready");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
