import type { PrismaClient } from "@rakazo/db";
import { currentDbContext } from "@rakazo/db";
import { afterEach, expect, it, vi } from "vitest";
import { createExpoPushProvider } from "./expo-push-factory.js";
import { MemoryPushTokenStore } from "./push-token-store.test-support.js";

afterEach(() => vi.unstubAllGlobals());

const sharedToken = "ExponentPushToken[shared-device]";
const unread = new Map([
  ["family", 2],
  ["work", 3],
]);
const message = {
  kind: "completion" as const,
  title: "Finished",
  body: "Ready",
  botId: "bot",
  threadId: "thread",
  badge: 1,
};
const context = (userId: string) => ({
  userId,
  spaceId: "space",
  operationId: "notify",
  traceId: "notify",
  signal: new AbortController().signal,
});

async function fixture() {
  const sessions = new Map<string, Date>();
  const store = new MemoryPushTokenStore();
  const tokens = Object.assign(store, {
    deviceForToken: vi.fn(async (token: string) => {
      const live = await Promise.all(
        [...unread].map(async ([userId, count]) =>
          (await store.list(userId)).some(
            (row) =>
              row.token === token &&
              row.sessionId &&
              (sessions.get(row.sessionId)?.getTime() ?? 0) > Date.now(),
          )
            ? [count]
            : [],
        ),
      );
      return {
        badge: live.flat().reduce((sum, count) => sum + count, 0),
        accounts: live.flat().length,
      };
    }),
  });
  for (const userId of unread.keys()) {
    const sessionId = `${userId}-session`;
    sessions.set(sessionId, new Date(Date.now() + 60_000));
    await tokens.save(userId, sharedToken, sessionId);
  }
  const prisma = {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        expect(currentDbContext()?.kind).toBe("system");
        return { email: `${where.id}@example.test` };
      }),
    },
    session: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => {
        expect(currentDbContext()?.kind).toBe("system");
        const expiresAt = sessions.get(where.id);
        return expiresAt ? { expiresAt } : null;
      }),
    },
  } as unknown as Pick<PrismaClient, "user" | "session">;
  return { tokens, sessions, prisma };
}

it.each([
  [
    { authUrl: " https://api.example.test:8443/auth/ ", webOrigin: "https://web.example.test" },
    "https://api.example.test:8443",
  ],
  [{ webOrigin: " https://web.example.test/base/ " }, "https://web.example.test"],
  [{ authUrl: " ", webOrigin: "https://web.example.test" }, "https://web.example.test"],
  [{}, "http://127.0.0.1:5173"],
])(
  "composes API and worker pushes with account subtitles, canonical server and shared-device badges (%j)",
  async (options, origin) => {
    const { prisma, tokens } = await fixture();
    const payloads: Array<Record<string, unknown>> = [];
    const fetch = vi.fn(async (_url: unknown, init: RequestInit) => {
      expect(new Headers(init.headers).get("authorization")).toBe("Bearer offline-expo-token");
      payloads.push(JSON.parse(String(init.body)));
      return Response.json({ data: { status: "ok", id: `ticket-${payloads.length}` } });
    });
    vi.stubGlobal("fetch", fetch);
    const jobs = {
      enqueue: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      close: vi.fn(async () => undefined),
    };
    const provider = createExpoPushProvider(prisma, tokens, {
      ...options,
      jobs,
      accessToken: "offline-expo-token",
    });
    for (const userId of unread.keys())
      expect(await provider.deliver(message, context(userId))).toBe("delivered");
    expect(payloads).toMatchObject([
      {
        to: sharedToken,
        title: "Finished",
        subtitle: "family@example.test",
        badge: 5,
        data: { userId: "family", apiBase: origin },
      },
      {
        to: sharedToken,
        title: "Finished",
        subtitle: "work@example.test",
        badge: 5,
        data: { userId: "work", apiBase: origin },
      },
    ]);
    expect(payloads[0]?.data).not.toHaveProperty("accountLabel");
    expect(tokens.deviceForToken).toHaveBeenNthCalledWith(1, sharedToken);
    expect(tokens.deviceForToken).toHaveBeenNthCalledWith(2, sharedToken);
    expect(jobs.enqueue).toHaveBeenCalledTimes(2);
    expect(jobs.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "push.receipt",
        payload: expect.objectContaining({
          userId: "family",
          ticketId: "ticket-1",
          tokenDigest: expect.any(String),
        }),
      }),
    );
  },
);

it("names the account only while the device holds several live logins", async () => {
  const { prisma, tokens, sessions } = await fixture();
  const payloads: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init: RequestInit) => {
      payloads.push(JSON.parse(String(init.body)));
      return Response.json({ data: { status: "ok" } });
    }),
  );
  const provider = createExpoPushProvider(prisma, tokens, {
    authUrl: "https://api.example.test/auth",
  });
  sessions.delete("family-session");
  expect(await provider.deliver(message, context("family"))).toBe("undeliverable");
  expect(await provider.deliver(message, context("work"))).toBe("delivered");
  expect(payloads).toMatchObject([
    { title: "Finished", badge: 3, data: { userId: "work", apiBase: "https://api.example.test" } },
  ]);
  expect(payloads[0]).not.toHaveProperty("subtitle");
});

it.each(["file:///tmp/server", "rakazo://thread"])(
  "rejects a non-HTTP notification server (%s)",
  async (authUrl) => {
    const { prisma, tokens } = await fixture();
    expect(() => createExpoPushProvider(prisma, tokens, { authUrl })).toThrow("Push server URL");
  },
);
