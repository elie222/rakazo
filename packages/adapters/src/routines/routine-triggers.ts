import { randomBytes } from "node:crypto";
import type { AdapterContext, SecretStore } from "@rakazo/adapter-kit";
import type { RoutineEmailSenders } from "@rakazo/contracts";
import { RoutineEmailSendersSchema } from "@rakazo/contracts";
import { messagingProviderName, messagingProviderNamed } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";

export const EMAIL_NOT_RECEIVED = "This server doesn't receive email.";

/** The events besides its timing that start a routine, as the routine row stores them. */
export type RoutineEvents = {
  webhookEnabled: boolean;
  githubEnabled: boolean;
  messageProvider: string | null;
  emailSenders: RoutineEmailSenders | null;
};

export const NO_ROUTINE_EVENTS: RoutineEvents = {
  webhookEnabled: false,
  githubEnabled: false,
  messageProvider: null,
  emailSenders: null,
};

type StoredRoutineEvents = Omit<RoutineEvents, "emailSenders"> & { emailSenders: string | null };

export function hasRoutineEvents(events: StoredRoutineEvents): boolean {
  return Boolean(
    events.webhookEnabled || events.githubEnabled || events.messageProvider || events.emailSenders,
  );
}

/** A routine's events as a bot reads and writes them (`on`); absent ones are left out. */
export function routineEventsView(row: StoredRoutineEvents) {
  const email = RoutineEmailSendersSchema.safeParse(row.emailSenders).data;
  return {
    ...(row.webhookEnabled ? { webhook: true } : {}),
    ...(row.githubEnabled ? { git: true } : {}),
    ...(row.messageProvider ? { chat: messagingProviderName(row.messageProvider) } : {}),
    ...(email ? { email } : {}),
  };
}

/** An email trigger needs a server that receives mail and a bot with an address. */
export async function emailTriggerError(
  prisma: PrismaClient,
  domain: string | undefined,
  botId: string,
): Promise<string | undefined> {
  if (!domain) return EMAIL_NOT_RECEIVED;
  const row = await prisma.botEmailAddress.findUnique({
    where: { botId },
    select: { botId: true },
  });
  return row ? undefined : "Choose an email address for this bot first.";
}

/** A bot's `on` argument before the bot's own connections are checked. */
type ToolEvents = {
  webhook: boolean;
  git: boolean;
  chat: string | null;
  email: RoutineEmailSenders | null;
};

/** Read a tool's `on` object (or its JSON text); blank fields count as absent. */
export function toolEventsFromArg(
  value: unknown,
): { ok: true; on: ToolEvents } | { error: string } {
  let raw = value;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { error: 'on must be an object like {"webhook":true}.' };
    }
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { error: 'on must be an object like {"webhook":true}.' };
  }
  const fields = raw as Record<string, unknown>;
  const unknown = Object.keys(fields).filter(
    (key) => !["webhook", "git", "chat", "email"].includes(key),
  );
  if (unknown.length) return { error: `on takes webhook, git, chat or email, not ${unknown[0]}.` };
  const flag = (key: "webhook" | "git") => {
    const field = fields[key];
    if (field === undefined || field === null || field === "") return false;
    if (typeof field === "boolean") return field;
    return undefined;
  };
  const webhook = flag("webhook");
  const git = flag("git");
  if (webhook === undefined || git === undefined) {
    return { error: "on.webhook and on.git are true or false." };
  }
  if (
    fields.chat !== undefined &&
    fields.chat !== null &&
    (typeof fields.chat !== "string" || fields.chat.length > MAX_CHAT_NAME_LENGTH)
  ) {
    return { error: "on.chat is the name of a connected chat app." };
  }
  const chat = typeof fields.chat === "string" && fields.chat.trim() ? fields.chat.trim() : null;
  let email: RoutineEmailSenders | null = null;
  if (fields.email !== undefined && fields.email !== null && fields.email !== "") {
    const parsed = RoutineEmailSendersSchema.safeParse(fields.email);
    if (!parsed.success) return { error: 'on.email is "owner" or "domain".' };
    email = parsed.data;
  }
  return { ok: true, on: { webhook, git, chat, email } };
}

/** A chat app's name is a word or two; anything longer is not one. */
const MAX_CHAT_NAME_LENGTH = 80;

/**
 * A tool's `on` as only the events it turns on, trimmed: `{}` when it turns none on (on an update,
 * that removes them), undefined when it was left out. The approval
 * card, the stored request and the handler all see this form, so padding in a field the
 * handler ignores can't push an event past what the card shows.
 */
export function canonicalToolEvents(
  value: unknown,
): { ok: true; on: Record<string, unknown> | undefined } | { error: string } {
  if (value === undefined || value === null || value === "") return { ok: true, on: undefined };
  const parsed = toolEventsFromArg(value);
  if ("error" in parsed) return parsed;
  const { webhook, git, chat, email } = parsed.on;
  const on = {
    ...(webhook ? { webhook: true } : {}),
    ...(git ? { git: true } : {}),
    ...(chat ? { chat } : {}),
    ...(email ? { email } : {}),
  };
  return { ok: true, on };
}

/** Whether a tool's `on` turns any event on; one it cannot read saves nothing, so asks none. */
export function asksRoutineEvents(value: unknown): boolean {
  if (value === undefined || value === null || value === "") return false;
  const parsed = toolEventsFromArg(value);
  if ("error" in parsed) return false;
  const { webhook, git, chat, email } = parsed.on;
  return Boolean(webhook || git || chat || email);
}

/**
 * The routine events a bot's `on` asks for, checked against what the bot can receive. Webhook,
 * Git and email deliveries run as the bot's creator and a chat message as the person who linked
 * the app, the creator again, so only their routines start on events: anyone else's would never
 * run. A chat trigger names the app this bot is connected to; email needs this server to receive
 * mail and the bot an address, as the routine editor requires.
 */
export async function resolveRoutineEvents(
  deps: { prisma: PrismaClient; inboundEmailDomain?: string | undefined },
  bot: { id: string; userId: string },
  userId: string,
  on: ToolEvents,
): Promise<{ ok: true; events: RoutineEvents } | { error: string }> {
  const events: RoutineEvents = {
    webhookEnabled: on.webhook,
    githubEnabled: on.git,
    messageProvider: null,
    emailSenders: on.email,
  };
  if (!on.webhook && !on.git && !on.chat && !on.email) return { ok: true, events };
  if (bot.userId !== userId) {
    return { error: "Only the bot's creator can start its routines from events." };
  }
  if (on.chat) {
    const identity = await deps.prisma.messagingIdentity.findUnique({
      where: { botId: bot.id },
      select: { provider: true },
    });
    if (!identity) {
      return { error: "This bot is not connected to a chat app. The user connects one first." };
    }
    const provider = messagingProviderNamed(on.chat, [identity.provider]);
    if (!provider) {
      return {
        error: `This bot's chat app is ${messagingProviderName(identity.provider)}, not ${on.chat}.`,
      };
    }
    events.messageProvider = provider;
  }
  if (on.email) {
    const error = await emailTriggerError(deps.prisma, deps.inboundEmailDomain, bot.id);
    if (error) return { error };
  }
  return { ok: true, events };
}

const WEBHOOK_KEY_KIND = "webhook";

/**
 * Store a new webhook key for the bot and return it. The key signs both its webhook and its Git
 * deliveries. `replace` rotates an existing key; without it, a bot that already has one keeps it
 * and nothing is returned, so a key in use elsewhere never changes under it. A key stored here
 * but not saved (another one landed first) is removed by the store's write-ahead cleanup.
 */
export async function storeBotWebhookKey(
  deps: { prisma: PrismaClient; secretStore: Pick<SecretStore, "put"> },
  bot: { id: string; spaceId: string; userId: string },
  context: AdapterContext,
  options: { replace: boolean },
): Promise<string | null> {
  if (!options.replace) {
    const current = await deps.prisma.bot.findUnique({
      where: { id: bot.id },
      select: { webhookSecretId: true },
    });
    if (current?.webhookSecretId) return null;
  }
  const plaintext = randomBytes(32).toString("base64url");
  const stored = await deps.secretStore.put(plaintext, context);
  const saved = await deps.prisma.$transaction(async (tx) => {
    const [locked] = await tx.$queryRaw<Array<{ webhookSecretId: string | null }>>`
      SELECT "webhookSecretId" FROM "bots" WHERE id = ${bot.id} FOR UPDATE`;
    if (!locked) return false;
    const previousSecretId = locked.webhookSecretId;
    if (previousSecretId && !options.replace) return false;
    await tx.secret.create({
      data: {
        id: stored.id,
        userId: bot.userId,
        spaceId: bot.spaceId,
        kind: WEBHOOK_KEY_KIND,
        ciphertext: stored.ciphertext,
      },
    });
    await tx.bot.update({ where: { id: bot.id }, data: { webhookSecretId: stored.id } });
    if (previousSecretId) {
      await tx.secret.deleteMany({
        where: {
          id: previousSecretId,
          spaceId: bot.spaceId,
          userId: bot.userId,
          kind: WEBHOOK_KEY_KIND,
        },
      });
    }
    return true;
  });
  return saved ? plaintext : null;
}
