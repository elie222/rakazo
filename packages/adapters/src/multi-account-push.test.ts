import { afterEach, expect, it, vi } from "vitest";
import { ExpoPushProvider } from "./expo-push.js";
import { MemoryPushTokenStore } from "./push-token-store.test-support.js";

afterEach(() => vi.unstubAllGlobals());

const message = {
  kind: "completion" as const,
  title: "Finished",
  body: "Ready",
  botId: "bot",
  threadId: "thread",
};
const context = (userId: string) => ({
  userId,
  spaceId: "space",
  operationId: "notify",
  traceId: "notify",
  signal: new AbortController().signal,
});

it("delivers two saved accounts to one device with distinct account targets", async () => {
  const tokens = new MemoryPushTokenStore();
  await tokens.save("family", "ExponentPushToken[shared]", "family-session");
  await tokens.save("work", "ExponentPushToken[shared]", "work-session");
  const payloads: Array<Record<string, unknown>> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      payloads.push(JSON.parse(String(init.body)));
      return Response.json({ data: { status: "ok" } });
    }),
  );
  const provider = new ExpoPushProvider(tokens, {
    sessionExpiresAt: async () => new Date(Date.now() + 60_000),
    accountLabel: async (id) => `${id}@example.test`,
    deviceForToken: async () => ({ badge: 0, accounts: 2 }),
    apiBase: "https://api.example.test",
  });
  await provider.deliver(message, context("family"));
  await provider.deliver(message, context("work"));
  expect(payloads).toHaveLength(2);
  expect(payloads[0]).toMatchObject({
    to: "ExponentPushToken[shared]",
    title: "Finished",
    subtitle: "family@example.test",
    data: { userId: "family", apiBase: "https://api.example.test" },
  });
  expect(payloads[1]).toMatchObject({
    to: "ExponentPushToken[shared]",
    data: { userId: "work" },
  });
  expect(payloads[0]?.collapseId).not.toBe(payloads[1]?.collapseId);
  await tokens.endSession("family", "family-session");
  expect(await provider.hasPushRecipient("family")).toBe(false);
  expect(await provider.hasPushRecipient("work")).toBe(true);
});

it("fans out to live devices, deduplicates their sessions, and ignores revoked sessions", async () => {
  const tokens = new MemoryPushTokenStore();
  await tokens.save("family", "ExponentPushToken[phone]", "phone-session");
  await tokens.save("family", "ExponentPushToken[tablet]", "tablet-session");
  await tokens.save("family", "ExponentPushToken[phone]", "second-phone-session");
  await tokens.save("family", "ExponentPushToken[old]", "revoked-session");
  const sent: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      sent.push(JSON.parse(String(init.body)).to);
      return Response.json({ data: { status: "ok" } });
    }),
  );
  const provider = new ExpoPushProvider(tokens, {
    sessionExpiresAt: async (id) =>
      id === "revoked-session" ? null : new Date(Date.now() + 60_000),
  });
  expect(await provider.deliver(message, context("family"))).toBe("delivered");
  expect(sent.sort()).toEqual(["ExponentPushToken[phone]", "ExponentPushToken[tablet]"]);
});

it.each(["label", "badge"])(
  "does not deliver after logout while the %s lookup waits",
  async (lookup) => {
    const tokens = new MemoryPushTokenStore();
    await tokens.save("family", "ExponentPushToken[phone]", "phone-session");
    let release!: () => void;
    let entered!: () => void;
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const ready = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fetch = vi.fn(async () => Response.json({ data: { status: "ok" } }));
    vi.stubGlobal("fetch", fetch);
    const provider = new ExpoPushProvider(tokens, {
      sessionExpiresAt: async () => new Date(Date.now() + 60_000),
      ...(lookup === "label"
        ? {
            deviceForToken: async () => ({ badge: 0, accounts: 2 }),
            accountLabel: async () => {
              entered();
              await waiting;
              return "family@example.test";
            },
          }
        : {
            deviceForToken: async () => {
              entered();
              await waiting;
              return { badge: 0, accounts: 1 };
            },
          }),
    });
    const delivering = provider.deliver(message, context("family"));
    await ready;
    await tokens.endSession("family", "phone-session");
    release();
    expect(await delivering).toBe("undeliverable");
    expect(fetch).not.toHaveBeenCalled();
  },
);

it("does not retry a private push after its login ends", async () => {
  const tokens = new MemoryPushTokenStore();
  await tokens.save("family", "ExponentPushToken[phone]", "phone-session");
  const fetch = vi.fn(async () => {
    await tokens.endSession("family", "phone-session");
    return Response.json({ errors: [{ message: "retry" }] }, { status: 429 });
  });
  vi.stubGlobal("fetch", fetch);
  const provider = new ExpoPushProvider(tokens, {
    sessionExpiresAt: async () => new Date(Date.now() + 60_000),
    retryDelaysMs: [0],
  });
  expect(await provider.deliver(message, context("family"))).toBe("undeliverable");
  expect(fetch).toHaveBeenCalledOnce();
});
