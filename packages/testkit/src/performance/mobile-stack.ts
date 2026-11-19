import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { asSystem, createDb } from "@rakazo/db";
import { bestEffort } from "@rakazo/logging";
import { startPostgres } from "../cli/postgres.js";
import { startIosScreenshotBackend } from "../screenshots/ios-screenshot-backend.js";
import { ensurePlan, ensureUser, rpc } from "../screenshots/ios-screenshot-seed.js";
import { startDelayProxy } from "./delay-proxy.js";
import { parseTcpPort } from "./performance-report.js";
import { argument, nonnegativeInteger, repositoryRoot as root } from "./performance-stack.js";
import { benchmarkBot, seedBenchmarkThread } from "./web-chat-fixture.js";

const EMAIL = "mobile-perf@example.test";
const PASSWORD = "mobile-perf-password-1234";
const MESSAGES_PER_CHAT = 100;

const delayMs = nonnegativeInteger(argument("--delay") ?? "0");
const apiPort = parseTcpPort(argument("--port") ?? "3120", "--port");
// The proxy listens on the next port, so check it before anything starts.
const proxyPort = delayMs > 0 ? parseTcpPort(String(apiPort + 1), "--port plus one") : 0;

// The seeder writes encrypted messages, so it shares the local API's keys.
Object.assign(process.env, {
  BETTER_AUTH_SECRET: "mobile-perf-auth-secret-over-32-characters",
  ENCRYPTION_KEY: "mobile-perf-encryption-key-over-32-characters",
  SCREEN_PROXY_SECRET: "mobile-perf-screen-secret-over-32-characters",
});

// Ctrl-C only marks the stack to stop, so a step already starting finishes and is cleaned up.
const interrupted = new AbortController();
process.once("SIGINT", () => interrupted.abort());
process.once("SIGTERM", () => interrupted.abort());

const dataDir = await mkdtemp(path.join(os.tmpdir(), "rakazo-mobile-perf-"));
const stops: Array<[label: string, stop: () => Promise<unknown>]> = [
  ["remove the data directory", () => rm(dataDir, { recursive: true, force: true })],
];
try {
  // Always its own container: a CI_POSTGRES_URL server can be shared with other runs.
  delete process.env.CI_POSTGRES_URL;
  const postgres = await startPostgres(interrupted.signal);
  stops.push(["stop Postgres", () => postgres.stop()]);
  if (!interrupted.signal.aborted) await serve(postgres.getConnectionUri());
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  for (const [label, stop] of stops.reverse()) await bestEffort(label, stop());
  process.exit();
}

async function serve(serverUrl: string) {
  const backend = await startIosScreenshotBackend({ root, serverUrl, port: apiPort, dataDir });
  stops.push(["stop the API", () => backend.stop()]);
  if (interrupted.signal.aborted) return;
  await seed(backend);

  let appUrl = backend.apiUrl;
  if (delayMs > 0) {
    const proxy = await startDelayProxy({ target: backend.apiUrl, port: proxyPort, delayMs });
    stops.push(["stop the delay proxy", () => proxy.close()]);
    appUrl = proxy.url;
  }
  if (interrupted.signal.aborted) return;
  console.log(
    [
      "",
      `EXPO_PUBLIC_API_URL=${appUrl}`,
      ...(delayMs > 0 ? [`Each request is held ${delayMs} ms.`] : []),
      `Sign in with ${EMAIL} / ${PASSWORD}`,
      "Ctrl-C stops the stack.",
    ].join("\n"),
  );
  await new Promise((resolve) => interrupted.signal.addEventListener("abort", resolve));
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
