import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asSystem, createDb } from "@rakazo/db";
import { startPostgres } from "../cli/postgres.js";
import { startIosScreenshotBackend } from "../screenshots/ios-screenshot-backend.js";
import { ensurePlan, ensureUser, rpc } from "../screenshots/ios-screenshot-seed.js";
import { startDelayProxy } from "./delay-proxy.js";
import {
  argument,
  nonnegativeInteger,
  positiveInteger,
  repositoryRoot as root,
} from "./performance-stack.js";
import { benchmarkBot, seedBenchmarkThread } from "./web-chat-fixture.js";

const EMAIL = "mobile-perf@example.test";
const PASSWORD = "mobile-perf-password-1234";
const MESSAGES_PER_CHAT = 100;

const delayMs = nonnegativeInteger(argument("--delay") ?? "0");
const apiPort = positiveInteger(argument("--port") ?? "3120");

// The seeder writes encrypted messages, so it shares the local API's keys.
Object.assign(process.env, {
  BETTER_AUTH_SECRET: "mobile-perf-auth-secret-over-32-characters",
  ENCRYPTION_KEY: "mobile-perf-encryption-key-over-32-characters",
  SCREEN_PROXY_SECRET: "mobile-perf-screen-secret-over-32-characters",
});

const dataDir = await mkdtemp(path.join(os.tmpdir(), "rakazo-mobile-perf-"));
// Always its own container: a CI_POSTGRES_URL server can be shared with other runs.
delete process.env.CI_POSTGRES_URL;
const postgres = await startPostgres();
const stops: Array<() => Promise<unknown>> = [
  () => rm(dataDir, { recursive: true, force: true }),
  () => postgres.stop(),
];
let stopping = false;
async function stop(code: number) {
  if (stopping) return;
  stopping = true;
  for (const step of stops.reverse()) await step().catch((error: unknown) => console.error(error));
  process.exit(code);
}
process.once("SIGINT", () => void stop(0));
process.once("SIGTERM", () => void stop(0));

try {
  const backend = await startIosScreenshotBackend({
    root,
    serverUrl: postgres.getConnectionUri(),
    port: apiPort,
    dataDir,
  });
  stops.push(() => backend.stop());
  await seed(backend);

  let appUrl = backend.apiUrl;
  if (delayMs > 0) {
    const proxy = await startDelayProxy({ target: backend.apiUrl, port: apiPort + 1, delayMs });
    stops.push(() => proxy.close());
    appUrl = proxy.url;
  }
  console.log(
    [
      "",
      `EXPO_PUBLIC_API_URL=${appUrl}${delayMs > 0 ? ` (each request held ${delayMs} ms)` : ""}`,
      `Sign in with ${EMAIL} / ${PASSWORD}`,
      "Ctrl-C stops the stack.",
    ].join("\n"),
  );
} catch (error) {
  console.error(error);
  await stop(1);
}

/** A paid account past onboarding, with 100-message chats in two Spaces. */
async function seed(backend: Awaited<ReturnType<typeof startIosScreenshotBackend>>) {
  const { apiUrl } = backend;
  const { headers } = await ensureUser(apiUrl, EMAIL, PASSWORD, "Mobile Perf");
  const me = await rpc<{ userId: string }>(apiUrl, headers, "me");
  const db = createDb(backend.databaseUrl, { applicationName: "mobile-perf-seed" });
  try {
    const prisma = asSystem(db.prisma, "mobile performance fixture");
    await ensurePlan({
      apiUrl,
      headers,
      prisma,
      complete: backend.completeCheckout,
      userId: me.userId,
      trial: false,
    });
    await prisma.signupSurvey.upsert({
      where: { userId: me.userId },
      create: { userId: me.userId, use: "work" },
      update: {},
    });
    const second = await rpc<{ id: string }>(apiUrl, headers, "spaces/create", {
      name: "Second space",
    });
    const chats = [
      ...["Alpha", "Bravo", ...numbered("Same")].map((name) => ({ name, headers })),
      ...numbered("Other").map((name) => ({
        name,
        headers: { ...headers, "x-rakazo-space-id": second.id },
      })),
    ];
    for (const chat of chats) {
      const bot = await rpc<{ id: string }>(
        apiUrl,
        chat.headers,
        "bots/create",
        benchmarkBot(chat.name),
      );
      await seedBenchmarkThread(db.prisma, bot.id, chat.name, MESSAGES_PER_CHAT);
    }
  } finally {
    await db.prisma.$disconnect();
    await db.pool.end();
  }
}

function numbered(prefix: string) {
  return [1, 2, 3, 4, 5].map((index) => `${prefix} ${index}`);
}
