import { createHash } from "node:crypto";
import { TelegramAdapter, TelegramFormatConverter } from "@chat-adapter/telegram";
import { getLogger } from "@rakazo/logging";
import type { AdapterPostableMessage, CardElement, Root } from "chat";
import {
  convertEmojiPlaceholders,
  isLinkNode,
  parseMarkdown,
  text,
  toPlainText,
  walkAst,
} from "chat";
import type { MessagingPlatform } from "../../../chat-sdk-surface.js";
import type { MessagingMountContext } from "../../../messaging-platform-descriptor.js";
import {
  asRecord,
  defineMessagingPlatform,
  stringField,
} from "../../../messaging-platform-descriptor.js";

/**
 * Both the token and the secret are required: without the secret token the adapter accepts
 * unsigned webhook posts, so a forged update could reach inbound processing.
 */
export const telegramMessaging = defineMessagingPlatform({
  env: {
    telegramBotToken: { name: "TELEGRAM_BOT_TOKEN", required: true },
    telegramWebhookSecret: { name: "TELEGRAM_WEBHOOK_SECRET_TOKEN", required: true },
    /** Extra named Telegram bots (TELEGRAM_BOT_TOKEN_<NAME>), e.g. one per space. */
    telegramBots: { read: telegramBotsFromEnv },
  },
  mount(env, options) {
    return telegramPlatform("telegram", env.telegramBotToken, env.telegramWebhookSecret, options);
  },
  // Same rules as the default bot; each named bot has its own token and so
  // its own getUpdates slot. The surface maps their native "telegram:" thread
  // ids to "telegram-<name>:" so conversations with each bot stay distinct.
  named(env, options) {
    const tokens = new Set<string>();
    if (options.defaultMounted && env.telegramBotToken) tokens.add(env.telegramBotToken.trim());
    const platforms: MessagingPlatform[] = [];
    for (const bot of env.telegramBots ?? []) {
      const provider = `telegram-${bot.name}`;
      if (tokens.has(bot.botToken.trim())) {
        getLogger().warn("skipping Telegram bot that reuses another bot's token", { provider });
        continue;
      }
      tokens.add(bot.botToken.trim());
      platforms.push({
        ...telegramPlatform(provider, bot.botToken, bot.webhookSecret, options),
        adapterName: "telegram",
      });
    }
    return platforms;
  },
});

/** One extra Telegram bot, mounted as provider `telegram-<name>`. */
export interface TelegramBotCredentials {
  name: string;
  botToken: string;
  webhookSecret: string;
}

const TELEGRAM_NAMED_TOKEN = /^TELEGRAM_BOT_TOKEN_([A-Z0-9]+)$/;

/**
 * Extra Telegram bots from TELEGRAM_BOT_TOKEN_<NAME> plus
 * TELEGRAM_WEBHOOK_SECRET_TOKEN_<NAME>. Each is its own Telegram bot (own
 * token, own getUpdates slot), so one person can link a different Rakazo bot
 * — typically one per space — to each. <NAME> is letters and digits only and
 * becomes the provider id `telegram-<name>` (lowercased), which also names
 * its webhook route. A name with no secret is skipped, like the default bot.
 */
export function telegramBotsFromEnv(
  env: Record<string, string | undefined>,
): TelegramBotCredentials[] {
  const bots: TelegramBotCredentials[] = [];
  for (const [key, value] of Object.entries(env)) {
    const suffix = TELEGRAM_NAMED_TOKEN.exec(key)?.[1];
    if (!suffix) continue;
    const botToken = value?.trim();
    const webhookSecret = env[`TELEGRAM_WEBHOOK_SECRET_TOKEN_${suffix}`]?.trim();
    if (!botToken || !webhookSecret) continue;
    bots.push({ name: suffix.toLowerCase(), botToken, webhookSecret });
  }
  bots.sort((a, b) => a.name.localeCompare(b.name));
  return bots;
}

function telegramPlatform(
  provider: string,
  botToken: string,
  secretToken: string,
  options: MessagingMountContext,
): MessagingPlatform {
  const adapter = new TelegramAdapterWithLinkAddresses({
    botToken,
    secretToken,
    // Auto mode long-polls when no webhook is registered, for deployments
    // without a public HTTPS endpoint. Only the API process may poll: it
    // owns the inbound sink, and Telegram allows one getUpdates per bot.
    mode: options.pollInboundMessages ? "auto" : "webhook",
  });
  return {
    provider,
    capabilities: { direct: true, groups: true, receipt: null, files: true },
    ...withTelegramRedelivery(adapter),
    ...telegramGroupHooks(adapter),
    isPermanentSendError: isTelegramBlocked,
  };
}

/**
 * The key the Telegram adapter claims each webhook update under (chat-adapter
 * 4.43), released when processing fails so Telegram's retry is processed. The
 * redelivery test fails if an SDK upgrade moves it.
 */
function withTelegramRedelivery(adapter: TelegramAdapter) {
  return {
    adapter,
    redeliveryKeys: (payload: unknown) => {
      const scope = createHash("sha256").update(adapter.botUserId!).digest("hex");
      return [`${adapter.name}:webhook-update:${scope}:${asRecord(payload)?.update_id}`];
    },
  };
}

const telegramFormat = new TelegramFormatConverter();

/**
 * The plain text sent when Telegram rejects a reply's formatting. Plain text drops the address of
 * a link or image, so each is written after its label first. `ast` is rewritten.
 */
export function telegramFallbackText(
  markdown: string,
  ast: Root = parseMarkdown(markdown),
): string {
  const plainText = toPlainText(
    walkAst(ast, (node) => {
      const link = isLinkNode(node);
      if (!link && node.type !== "image") return node;
      const label = link
        ? toPlainText({ type: "root", children: [{ type: "paragraph", children: node.children }] })
        : (node.alt ?? "");
      if (!label) return text(node.url);
      const bare = node.url.replace(/^(?:https?:\/\/|mailto:)/, "");
      if (label === node.url || label === bare || label === bare.replace(/\/$/, "")) {
        return text(label);
      }
      return text(`${label} (${node.url})`);
    }),
  );
  return plainText.trim() ? plainText : markdown;
}

/** The adapter builds its plain-text fallback itself; this is its one seam for that text. */
class TelegramAdapterWithLinkAddresses extends TelegramAdapter {
  protected override renderPlainTextMessage(
    message: AdapterPostableMessage,
    card: CardElement | null,
  ): string {
    return !card && typeof message === "object" && "markdown" in message
      ? telegramFallbackText(message.markdown)
      : super.renderPlainTextMessage(message, card);
  }
}

/**
 * Both texts the adapter may send for a Markdown part, as it renders them: MarkdownV2, and the
 * plain text it falls back to when Telegram rejects that. It truncates either past the limit.
 */
export function telegramPayloads(markdown: string): string[] {
  const ast = parseMarkdown(markdown);
  // The fallback rewrites the tree, so the formatted text is rendered first.
  return [telegramFormat.fromAst(ast), telegramFallbackText(markdown, ast)].map((text) =>
    convertEmojiPlaceholders(text, "gchat"),
  );
}

/** Telegram 403 (Chat SDK PermissionError): the user blocked the bot. */
function isTelegramBlocked(error: unknown): boolean {
  return error instanceof Error && error.name === "PermissionError";
}

/**
 * Group facts shared by every Telegram bot mount. Telegram names no roster,
 * so `participants` stays unset: channel members accumulate from the senders
 * seen, and a rosterless event never sweeps anyone out. Departures arrive one
 * service message at a time instead.
 */
function telegramGroupHooks(adapter: { readonly botUserId?: string }) {
  return {
    channelName: (raw: unknown) =>
      stringField(asRecord(asRecord(raw)?.chat) ?? {}, "title") ?? null,
    acceptsGroup: (raw: unknown) => asRecord(asRecord(raw)?.chat)?.type !== "channel",
    normalizeThreadId: telegramGroupThreadId,
    departures: (raw: unknown) => telegramDepartures(raw, adapter),
  };
}

/**
 * A `left_chat_member` service message names who left or was removed. When
 * that member is this mount's own bot, the whole channel ends: Telegram
 * delivers nothing from a chat the bot is no longer in.
 */
function telegramDepartures(
  raw: unknown,
  adapter: { readonly botUserId?: string },
): { addresses: string[]; botLeft: boolean } | undefined {
  const id = asRecord(asRecord(raw)?.left_chat_member)?.id;
  if (typeof id !== "number" && typeof id !== "string") return undefined;
  return adapter.botUserId === String(id)
    ? { addresses: [], botLeft: true }
    : { addresses: [String(id)], botLeft: false };
}

/**
 * A forum topic (`is_topic_message`) is its own conversation; a plain reply's
 * message thread id is not, so it collapses onto the group. Business thread
 * ids (`telegram:biz:<id>:<chat>`) have four segments and pass through.
 */
function telegramGroupThreadId(threadId: string, raw: unknown): string {
  if (asRecord(raw)?.is_topic_message === true) return threadId;
  const parts = threadId.split(":");
  return parts.length === 3 && parts[0] === "telegram" ? `${parts[0]}:${parts[1]}` : threadId;
}
