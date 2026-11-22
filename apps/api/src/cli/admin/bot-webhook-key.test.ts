import type { SecretStore } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { beforeEach, describe, expect, it, vi } from "vitest";

const storeBotWebhookKey = vi.hoisted(() => vi.fn());
const recordSecurityEvent = vi.hoisted(() => vi.fn());
vi.mock("@rakazo/adapters", () => ({ storeBotWebhookKey }));
vi.mock("@rakazo/db", () => ({ recordSecurityEvent }));

const { botWebhookKey } = await import("./bot-webhook-key.js");

const bot = { id: "bot_1", spaceId: "space_1", userId: "user_1", archivedAt: null };
const findUnique = vi.fn();
const context = {
  prisma: { bot: { findUnique } } as unknown as PrismaClient,
  secrets: {} as SecretStore,
  apiUrl: "https://app.example.test",
  signal: new AbortController().signal,
};
const url = "https://app.example.test/api/v1/bots/bot_1/webhook";

beforeEach(() => {
  vi.clearAllMocks();
  findUnique.mockResolvedValue(bot);
});

describe("botWebhookKey", () => {
  it("prints the URL and new key and records the operator change", async () => {
    storeBotWebhookKey.mockResolvedValue("new-key");
    await expect(botWebhookKey(context, "bot_1", false)).resolves.toEqual({
      text: `${url}\nnew-key`,
      json: { botId: "bot_1", url, key: "new-key", created: true },
    });
    expect(storeBotWebhookKey.mock.calls[0]?.[3]).toEqual({ replace: false });
    expect(recordSecurityEvent).toHaveBeenCalledWith({
      type: "credential.changed",
      userId: "user_1",
      spaceId: "space_1",
      metadata: {
        procedure: "admin.bot.webhookKey",
        kind: "webhook",
        botId: "bot_1",
        by: "operator",
      },
    });
  });

  it("never prints a key the bot already has", async () => {
    storeBotWebhookKey.mockResolvedValue(null);
    const result = await botWebhookKey(context, "bot_1", false);
    expect(result.json).toEqual({ botId: "bot_1", url, created: false });
    expect(result.text).toContain("--rotate replaces it");
    expect(recordSecurityEvent).not.toHaveBeenCalled();
  });

  it("prints the published inbound address when the deployment has one", async () => {
    storeBotWebhookKey.mockResolvedValue(null);
    const result = await botWebhookKey(
      { ...context, inboundOrigin: "https://hooks.example.test" },
      "bot_1",
      false,
    );
    expect(result.json.url).toBe("https://hooks.example.test/api/v1/bots/bot_1/webhook");
  });

  it("replaces the key on rotate", async () => {
    storeBotWebhookKey.mockResolvedValue("rotated");
    await botWebhookKey(context, "bot_1", true);
    expect(storeBotWebhookKey.mock.calls[0]?.[3]).toEqual({ replace: true });
  });

  it("refuses a missing or archived bot before issuing anything", async () => {
    findUnique.mockResolvedValueOnce(null);
    await expect(botWebhookKey(context, "bot_1", true)).rejects.toThrow("No bot has that id");
    findUnique.mockResolvedValueOnce({ ...bot, archivedAt: new Date() });
    await expect(botWebhookKey(context, "bot_1", true)).rejects.toThrow("archived");
    expect(storeBotWebhookKey).not.toHaveBeenCalled();
  });
});
