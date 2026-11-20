import { bestEffort, getLogger } from "@rakazo/logging";
import type {
  Adapter,
  AdapterPostableMessage,
  ChatInstance,
  EmojiValue,
  FormattedContent,
  Logger,
  Message,
  WebhookOptions,
} from "chat";
import { stringifyMarkdown } from "chat";

export interface DiscordAdapterConfig {
  botToken: string;
  publicKey: string;
  applicationId: string;
  /** Roles whose mentions count as mentions of the bot. */
  mentionRoleIds?: string[] | undefined;
  /** Consume the Gateway WebSocket in the one process that owns the inbound sink. */
  pollInboundMessages: boolean;
}

/** The adapter's native thread ids: `discord:{guildId}:{channelId}[:{threadId}]`. */
export interface DiscordThreadId {
  guildId: string;
  channelId: string;
  threadId?: string;
}

const THREAD_PREFIX = "discord:";

/**
 * How long one Gateway listener runs before the next re-arm. Discord's own
 * serverless example uses about ten minutes; five keeps reconnects rare without
 * holding a socket across a whole deploy.
 */
export const DISCORD_LISTEN_WINDOW_MS = 300_000;

/**
 * The Gateway has no acknowledgement to withhold, so a message whose processing
 * fails would be lost. Retry it here; downstream client nonces make a repeat
 * that partly succeeded harmless.
 */
export const DISCORD_GATEWAY_RETRY_DELAYS_MS = [5_000, 30_000, 120_000];

/**
 * A Gateway connection that fails to open retries well inside the five-minute
 * window, so a recoverable start failure costs seconds of ingress, not a window.
 */
export const DISCORD_START_RETRY_DELAYS_MS = [5_000, 30_000, 120_000];

// The adapter logs every Gateway re-arm at info; keep only its warnings and errors.
const discordLogger: Logger = {
  child: () => discordLogger,
  debug: () => undefined,
  info: () => undefined,
  warn: (message, bindings) => getLogger().warn(`discord: ${message}`, logBindings(bindings)),
  error: (message, bindings) => getLogger().error(`discord: ${message}`, logBindings(bindings)),
};

function logBindings(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

export function encodeDiscordThreadId({ guildId, channelId, threadId }: DiscordThreadId): string {
  return threadId
    ? `${THREAD_PREFIX}${guildId}:${channelId}:${threadId}`
    : `${THREAD_PREFIX}${guildId}:${channelId}`;
}

export function decodeDiscordThreadId(threadId: string): DiscordThreadId {
  const parts = threadId.split(":");
  if (parts.length < 3 || parts[0] !== "discord") {
    throw new Error(`Invalid Discord thread ID: ${threadId}`);
  }
  return parts[3]
    ? { guildId: parts[1]!, channelId: parts[2]!, threadId: parts[3] }
    : { guildId: parts[1]!, channelId: parts[2]! };
}

type LoadedDiscordAdapter = Adapter<DiscordThreadId> & {
  readonly userName: string;
  fetchChannelInfo?(threadId: string): Promise<{ name?: string | undefined }>;
  startGatewayListener(
    options: WebhookOptions,
    durationMs?: number,
    abortSignal?: AbortSignal,
    webhookUrl?: string,
  ): Promise<Response>;
};

/**
 * The Chat SDK keeps its routing entry point on the instance; a retry has to
 * reach the same path while skipping the dedupe key its first attempt wrote.
 */
type ChatRouter = ChatInstance & {
  routeIncomingMessage?: (
    adapter: Adapter,
    threadId: string,
    message: Message,
    deduplicate?: boolean,
  ) => Promise<void>;
};

/**
 * Discord through its Chat SDK adapter. The adapter and discord.js load only on
 * first use, so unconfigured processes never pay for them. Regular messages
 * arrive over the Gateway WebSocket; forwarded HTTP Interaction and GATEWAY_*
 * events still use the generic messaging webhook route.
 */
export class LazyDiscordAdapter implements Adapter<DiscordThreadId> {
  readonly name = "discord";
  private loaded: Promise<LoadedDiscordAdapter> | undefined;
  private implementation: LoadedDiscordAdapter | undefined;
  private listening: ReturnType<typeof setInterval> | undefined;
  private window: AbortController | undefined;
  private startRetry: ReturnType<typeof setTimeout> | undefined;
  private readonly retries = new Set<ReturnType<typeof setTimeout>>();
  // Channel name by channel id, learned once per channel. Discord's gateway message
  // carries no channel name, and team chat lists a conversation by the name it is
  // given, so one lookup per channel keeps the settings list readable.
  private readonly channelNames = new Map<string, string>();
  // A channel that could not be read is not retried on every message, so a bot without
  // Read History does not log once per message forever.
  private readonly unnamedChannels = new Set<string>();
  private readonly naming = new Set<string>();
  constructor(readonly config: DiscordAdapterConfig) {}

  /** The name of the channel a thread id belongs to, when this process has seen it. */
  channelNameForThread(threadId: string): string | null {
    const { channelId, guildId } = decodeDiscordThreadId(threadId);
    if (guildId === "@me") return null;
    return this.channelNames.get(channelId) ?? null;
  }

  /**
   * Learn the channel's name the first time a message arrives in it or goes out to
   * it. A channel that cannot be read stays unnamed rather than failing the message.
   */
  private async rememberChannelName(adapter: LoadedDiscordAdapter, threadId: string) {
    const { channelId, guildId } = decodeDiscordThreadId(threadId);
    if (guildId === "@me" || this.channelNames.has(channelId)) return;
    if (this.unnamedChannels.has(channelId) || this.naming.has(channelId)) return;
    this.naming.add(channelId);
    try {
      // A channel name is a nicety: an unreadable channel stays unnamed, logged once.
      const info = await bestEffort(
        `Discord channel name for ${channelId}`,
        adapter.fetchChannelInfo?.(threadId),
      );
      const name = info?.name?.trim();
      if (name) this.channelNames.set(channelId, name);
      else this.unnamedChannels.add(channelId);
    } finally {
      this.naming.delete(channelId);
    }
  }

  get userName() {
    return this.implementation?.userName ?? this.config.applicationId;
  }

  private load() {
    this.loaded ??= (async () => {
      const { createDiscordAdapter } = await import("@chat-adapter/discord");
      const adapter = createDiscordAdapter({
        botToken: this.config.botToken,
        publicKey: this.config.publicKey,
        applicationId: this.config.applicationId,
        // The Chat SDK reads a literal `@name` in a message as a mention of the bot. Its
        // default name is "bot", so a channel where somebody writes "the bot is down" would
        // summon the bot; the application id is a name nobody types and a real ping still
        // matches through the adapter's own id check.
        userName: this.config.applicationId,
        ...(this.config.mentionRoleIds ? { mentionRoleIds: this.config.mentionRoleIds } : {}),
        logger: discordLogger,
      });
      this.implementation = adapter as LoadedDiscordAdapter;
      return this.implementation;
    })().catch((error: unknown) => {
      this.loaded = undefined;
      throw error;
    });
    return this.loaded;
  }

  async initialize(chat: ChatInstance) {
    const adapter = await this.load();
    await adapter.initialize(this.config.pollInboundMessages ? this.retryingChat(chat) : chat);
    if (this.config.pollInboundMessages) this.startListening(adapter);
  }

  /**
   * The Chat instance the adapter sees while listening. The adapter catches and
   * logs whatever its own delivery throws, so the retry has to sit between the
   * adapter and the Chat instance to see the failure at all.
   */
  private retryingChat(chat: ChatInstance): ChatInstance {
    const router = chat as ChatRouter;
    const deliver = async (
      adapter: Adapter,
      threadId: string,
      message: Message,
      attempt = 0,
    ): Promise<void> => {
      // Read once per channel before the message is routed: team chat stores the name on the
      // conversation when it first sees the room, and an id is not a name. A second message in
      // the same channel is answered from the cache, and an unreadable channel stays unnamed.
      if (attempt === 0 && this.implementation) {
        await bestEffort(
          "Discord channel name",
          this.rememberChannelName(this.implementation, threadId),
        );
      }
      // A first delivery keeps the SDK's dedupe, so a replayed event stays a no-op. A retry
      // must not: the attempt that failed already claimed that key.
      const task =
        attempt === 0 || !router.routeIncomingMessage
          ? chat.handleIncomingMessage(adapter, threadId, message)
          : router.routeIncomingMessage.call(chat, adapter, threadId, message, false);
      // The retry handles the failure while the caller still learns of it.
      void task.catch((error: unknown) => {
        const delay = DISCORD_GATEWAY_RETRY_DELAYS_MS[attempt];
        getLogger().warn("discord inbound processing failed", {
          error: String(error),
          retrying: delay !== undefined && Boolean(this.listening),
        });
        if (delay === undefined || !this.listening) return;
        const timer = setTimeout(() => {
          this.retries.delete(timer);
          // The last attempt has no retry left to handle its failure, so it is logged here.
          void bestEffort(
            "Discord gateway retry delivery",
            deliver(adapter, threadId, message, attempt + 1),
          );
        }, delay);
        timer.unref?.();
        this.retries.add(timer);
      });
      return task;
    };
    return new Proxy(chat, {
      get: (target, key) => {
        if (key === "handleIncomingMessage") return deliver;
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  }

  /** Stop consuming the Gateway; the surface calls this on shutdown. */
  async stopPolling() {
    clearInterval(this.listening);
    this.listening = undefined;
    clearTimeout(this.startRetry);
    this.startRetry = undefined;
    this.window?.abort();
    this.window = undefined;
    for (const timer of this.retries) clearTimeout(timer);
    this.retries.clear();
  }

  private startListening(adapter: LoadedDiscordAdapter) {
    if (this.listening) return;
    const options: WebhookOptions = {
      // No webhook reply is waiting on this work; failures are retried by retryingChat.
      waitUntil: (task) => {
        void bestEffort("Discord gateway delivery", task);
      },
    };
    const listen = (attempt = 0) => {
      if (!this.listening) return;
      clearTimeout(this.startRetry);
      this.startRetry = undefined;
      // Abort the window this one replaces: two Gateway clients logged in at once
      // would each receive every message and mint threads the other cannot stop.
      this.window?.abort();
      // A fresh window each time keeps abort listeners from piling up on one signal.
      const window = new AbortController();
      this.window = window;
      adapter
        .startGatewayListener(options, DISCORD_LISTEN_WINDOW_MS, window.signal)
        .then((response) => {
          if (response.ok) return;
          getLogger().warn("discord inbound listener did not start", {
            status: response.status,
            retrying: attempt < DISCORD_START_RETRY_DELAYS_MS.length,
          });
          retryStart(attempt);
        })
        .catch((error: unknown) => {
          getLogger().warn("discord inbound listener failed", {
            error: String(error),
            retrying: attempt < DISCORD_START_RETRY_DELAYS_MS.length,
          });
          retryStart(attempt);
        });
    };
    /** A start that failed retries on its own, unless a newer window replaced it. */
    const retryStart = (attempt: number) => {
      const delay = DISCORD_START_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || !this.listening || this.window?.signal.aborted) return;
      clearTimeout(this.startRetry);
      const timer = setTimeout(() => {
        this.retries.delete(timer);
        this.startRetry = undefined;
        listen(attempt + 1);
      }, delay);
      timer.unref?.();
      this.retries.add(timer);
      this.startRetry = timer;
    };
    this.listening = setInterval(listen, DISCORD_LISTEN_WINDOW_MS);
    this.listening.unref?.();
    listen();
  }

  async handleWebhook(request: Request, options?: WebhookOptions) {
    return (await this.load()).handleWebhook(request, options);
  }
  async postMessage(threadId: string, message: AdapterPostableMessage) {
    const adapter = await this.load();
    void bestEffort("Discord channel name", this.rememberChannelName(adapter, threadId));
    return adapter.postMessage(threadId, message);
  }
  async editMessage(threadId: string, messageId: string, message: AdapterPostableMessage) {
    return (await this.load()).editMessage(threadId, messageId, message);
  }
  async deleteMessage(threadId: string, messageId: string) {
    await (await this.load()).deleteMessage(threadId, messageId);
  }
  async addReaction(threadId: string, messageId: string, emoji: EmojiValue | string) {
    await (await this.load()).addReaction(threadId, messageId, emoji);
  }
  async removeReaction(threadId: string, messageId: string, emoji: EmojiValue | string) {
    await (await this.load()).removeReaction(threadId, messageId, emoji);
  }
  async startTyping(threadId: string) {
    await (await this.load()).startTyping(threadId);
  }
  async fetchMessage(threadId: string, messageId: string) {
    const adapter = await this.load();
    return (await adapter.fetchMessage?.(threadId, messageId)) ?? null;
  }
  async fetchMessages(threadId: string, options?: Parameters<Adapter["fetchMessages"]>[1]) {
    return (await this.load()).fetchMessages(threadId, options);
  }
  async fetchThread(threadId: string) {
    return (await this.load()).fetchThread(threadId);
  }
  async openDM(userId: string) {
    return (await this.load()).openDM!(userId);
  }
  async getUser(userId: string) {
    return (await this.load()).getUser?.(userId) ?? null;
  }
  async disconnect() {
    await this.stopPolling();
  }
  parseMessage(raw: unknown) {
    if (!this.implementation) throw new Error("Discord adapter is not initialized");
    return this.implementation.parseMessage(raw);
  }
  renderFormatted(content: FormattedContent) {
    return this.implementation?.renderFormatted(content) ?? stringifyMarkdown(content);
  }
  encodeThreadId(platformData: DiscordThreadId) {
    return encodeDiscordThreadId(platformData);
  }
  decodeThreadId(threadId: string) {
    return decodeDiscordThreadId(threadId);
  }
  channelIdFromThreadId(threadId: string) {
    return threadId.split(":").slice(0, 3).join(":");
  }
  isDM(threadId: string) {
    return decodeDiscordThreadId(threadId).guildId === "@me";
  }
}
