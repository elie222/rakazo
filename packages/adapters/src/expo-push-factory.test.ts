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
    badgeForToken: vi.fn(async (token: string): Promise<number> => {
      const counts = await Promise.all(
        [...unread].map(async ([userId, count]) =>
          (await store.list(userId)).some(
            (row) =>
              row.token === token &&
              row.sessionId &&
              (sessions.get(row.sessionId)?.getTime() ?? 0) > Date.now(),
          )
            ? count
            : 0,
        ),
      );
      return counts.reduce((sum, count) => sum + count, 0);
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
  "composes API and worker pushes with account labels, canonical server and shared-device badges (%j)",
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
        title: "family@example.test · Finished",
        badge: 5,
        data: { userId: "family", accountLabel: "family@example.test", apiBase: origin },
      },
      {
        to: sharedToken,
        title: "work@example.test · Finished",
        badge: 5,
        data: { userId: "work", accountLabel: "work@example.test", apiBase: origin },
      },
    ]);
    expect(tokens.badgeForToken).toHaveBeenNthCalledWith(1, sharedToken);
    expect(tokens.badgeForToken).toHaveBeenNthCalledWith(2, sharedToken);
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

it("excludes a revoked account from delivery and the next shared-device badge", async () => {
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
    {
      title: "work@example.test · Finished",
      badge: 3,
      data: { userId: "work", apiBase: "https://api.example.test" },
    },
  ]);
});

it.each(["file:///tmp/server", "rakazo://thread"])(
  "rejects a non-HTTP notification server (%s)",
  async (authUrl) => {
    const { prisma, tokens } = await fixture();
    expect(() => createExpoPushProvider(prisma, tokens, { authUrl })).toThrow("Push server URL");
  },
);
