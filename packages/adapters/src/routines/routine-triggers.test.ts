import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import {
  canonicalToolEvents,
  EMAIL_NOT_RECEIVED,
  resolveRoutineEvents,
  routineEventsView,
  storeBotWebhookKey,
  toolEventsFromArg,
} from "./routine-triggers.js";

const bot = { id: "bot-1", userId: "owner-1" };
const none = { webhook: false, git: false, chat: null, email: null };

function triggerPrisma(options: { provider?: string; address?: boolean } = {}) {
  return {
    messagingIdentity: {
      findUnique: vi.fn(async () => (options.provider ? { provider: options.provider } : null)),
    },
    botEmailAddress: {
      findUnique: vi.fn(async () => (options.address ? { botId: bot.id } : null)),
    },
  } as unknown as PrismaClient;
}

describe("toolEventsFromArg", () => {
  it("reads an object or its JSON text and drops blank fields", () => {
    expect(toolEventsFromArg({ webhook: true, chat: " ", email: null })).toEqual({
      ok: true,
      on: { ...none, webhook: true },
    });
    expect(toolEventsFromArg('{"git":true,"email":"domain"}')).toEqual({
      ok: true,
      on: { ...none, git: true, email: "domain" },
    });
  });

  it("refuses unknown fields and senders the editor does not offer", () => {
    expect(toolEventsFromArg({ cron: "0 9 * * *" })).toEqual({
      error: "on takes webhook, git, chat or email, not cron.",
    });
    expect(toolEventsFromArg({ email: "anyone" })).toEqual({
      error: 'on.email is "owner" or "domain".',
    });
    expect(toolEventsFromArg({ webhook: "yes" })).toEqual({
      error: "on.webhook and on.git are true or false.",
    });
    expect(toolEventsFromArg("not json")).toEqual({
      error: 'on must be an object like {"webhook":true}.',
    });
  });
});

describe("canonicalToolEvents", () => {
  it("keeps only the events it turns on, so padding can't hide one", () => {
    expect(canonicalToolEvents({ chat: "   ", webhook: false, email: "domain" })).toEqual({
      ok: true,
      on: { email: "domain" },
    });
    expect(canonicalToolEvents({ chat: " Slack " })).toEqual({ ok: true, on: { chat: "Slack" } });
  });

  it("keeps an empty object, which removes events on an update, apart from no on at all", () => {
    expect(canonicalToolEvents({})).toEqual({ ok: true, on: {} });
    expect(canonicalToolEvents(undefined)).toEqual({ ok: true, on: undefined });
  });
});

describe("resolveRoutineEvents", () => {
  it("starts only the bot creator's routines from events", async () => {
    const prisma = triggerPrisma();
    expect(
      await resolveRoutineEvents({ prisma }, bot, "member-2", { ...none, webhook: true }),
    ).toEqual({ error: "Only the bot's creator can start its routines from events." });
    // Without events, anyone's routine is fine.
    expect(await resolveRoutineEvents({ prisma }, bot, "member-2", none)).toMatchObject({
      ok: true,
    });
  });

  it("takes the chat app this bot is connected to, by its name", async () => {
    const connected = { prisma: triggerPrisma({ provider: "slack" }) };
    expect(
      await resolveRoutineEvents(connected, bot, "owner-1", { ...none, chat: "Slack" }),
    ).toEqual({
      ok: true,
      events: {
        webhookEnabled: false,
        githubEnabled: false,
        messageProvider: "slack",
        emailSenders: null,
      },
    });
    expect(
      await resolveRoutineEvents(connected, bot, "owner-1", { ...none, chat: "Telegram" }),
    ).toEqual({ error: "This bot's chat app is Slack, not Telegram." });
    expect(
      await resolveRoutineEvents({ prisma: triggerPrisma() }, bot, "owner-1", {
        ...none,
        chat: "Slack",
      }),
    ).toEqual({ error: "This bot is not connected to a chat app. The user connects one first." });
  });

  it("needs a server that receives mail and a bot address for email", async () => {
    const email = { ...none, email: "owner" as const };
    expect(
      await resolveRoutineEvents(
        { prisma: triggerPrisma({ address: true }) },
        bot,
        "owner-1",
        email,
      ),
    ).toEqual({ error: EMAIL_NOT_RECEIVED });
    expect(
      await resolveRoutineEvents(
        { prisma: triggerPrisma(), inboundEmailDomain: "bots.example.com" },
        bot,
        "owner-1",
        email,
      ),
    ).toEqual({ error: "Choose an email address for this bot first." });
    expect(
      await resolveRoutineEvents(
        { prisma: triggerPrisma({ address: true }), inboundEmailDomain: "bots.example.com" },
        bot,
        "owner-1",
        email,
      ),
    ).toMatchObject({ ok: true, events: { emailSenders: "owner" } });
  });
});

describe("routineEventsView", () => {
  it("names the chat app and leaves out events that are off", () => {
    expect(
      routineEventsView({
        webhookEnabled: true,
        githubEnabled: false,
        messageProvider: "slack",
        emailSenders: "domain",
      }),
    ).toEqual({ webhook: true, chat: "Slack", email: "domain" });
  });
});

describe("storeBotWebhookKey", () => {
  const target = { id: "bot-1", spaceId: "space-1", userId: "owner-1" };
  const context = {
    operationId: "test",
    traceId: "test",
    spaceId: "space-1",
    userId: "owner-1",
    signal: new AbortController().signal,
  };

  function keyPrisma(current: string | null, locked: string | null = current) {
    const tx = {
      $queryRaw: vi.fn(async () => [{ webhookSecretId: locked }]),
      secret: { create: vi.fn(), deleteMany: vi.fn() },
      bot: { update: vi.fn() },
    };
    const prisma = {
      bot: { findUnique: vi.fn(async () => ({ webhookSecretId: current })) },
      $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
    } as unknown as PrismaClient;
    const put = vi.fn(async () => ({ id: "secret-new", ciphertext: "sealed", ref: "sealed" }));
    return { prisma, tx, put };
  }

  it("keeps a key the bot already has unless asked to replace it", async () => {
    const { prisma, put } = keyPrisma("secret-old");
    expect(
      await storeBotWebhookKey({ prisma, secretStore: { put } }, target, context, {
        replace: false,
      }),
    ).toBeNull();
    expect(put).not.toHaveBeenCalled();
  });

  it("saves a new key, and saves none when another landed first", async () => {
    const fresh = keyPrisma(null);
    const key = await storeBotWebhookKey(
      { prisma: fresh.prisma, secretStore: { put: fresh.put } },
      target,
      context,
      { replace: false },
    );
    expect(key).toMatch(/^[\w-]{43}$/);
    expect(fresh.tx.secret.create).toHaveBeenCalledWith({
      data: {
        id: "secret-new",
        userId: "owner-1",
        spaceId: "space-1",
        kind: "webhook",
        ciphertext: "sealed",
      },
    });
    expect(fresh.tx.bot.update).toHaveBeenCalledWith({
      where: { id: "bot-1" },
      data: { webhookSecretId: "secret-new" },
    });

    const raced = keyPrisma(null, "secret-other");
    expect(
      await storeBotWebhookKey(
        { prisma: raced.prisma, secretStore: { put: raced.put } },
        target,
        context,
        { replace: false },
      ),
    ).toBeNull();
    expect(raced.tx.secret.create).not.toHaveBeenCalled();
  });

  it("rotates and deletes the previous key when replacing", async () => {
    const { prisma, tx, put } = keyPrisma("secret-old");
    await storeBotWebhookKey({ prisma, secretStore: { put } }, target, context, { replace: true });
    expect(tx.secret.deleteMany).toHaveBeenCalledWith({
      where: { id: "secret-old", spaceId: "space-1", userId: "owner-1", kind: "webhook" },
    });
  });
});
