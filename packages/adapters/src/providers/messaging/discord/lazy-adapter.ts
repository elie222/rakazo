import { abortableDelay, retry } from "@rakazo/core";
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
  /**
   * The guilds this bot answers in. A Discord invite URL carries only the public
   * application id, so anyone can add the bot to their own server; a guild is
   * served only when the operator named it, the same way a static Slack
   * deployment is bound to the one workspace whose token it holds.
   */
  allowedGuildIds?: string[] | undefined;
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

/**
 * A channel whose name could not be read is asked again after this long. An error
 * says nothing about the channel, so the name still arrives once Discord answers;
 * asking on every message would only add a failing request to each one.
 */
export const DISCORD_CHANNEL_NAME_RETRY_MS = 300_000;

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
  /** Aborted when polling stops, so no retry wait outlives the listener it belongs to. */
  private stopSignal = new AbortController();
  // Channel name by channel id, learned once per channel. Discord's gateway message
  // carries no channel name, and team chat lists a conversation by the name it is
  // given, so one lookup per channel keeps the settings list readable.
  private readonly channelNames = new Map<string, string>();
  // A channel Discord answered for without a name has none to show: asking again would
  // only repeat the same answer.
  private readonly namelessChannels = new Set<string>();
  // The lookup already running, so a second message in the same channel waits for its
  // name instead of racing it and recording the conversation unnamed.
  private readonly naming = new Map<string, Promise<void>>();
  // When a channel whose lookup failed may be asked again; an error says nothing about
  // the channel, so it must not be treated as permanently unreadable.
  private readonly nameRetryAt = new Map<string, number>();
  // One warning per guild the operator did not allow, never one per message.
  private readonly refusedGuilds = new Set<string>();
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
  private rememberChannelName(adapter: LoadedDiscordAdapter, threadId: string): Promise<void> {
    const { channelId, guildId } = decodeDiscordThreadId(threadId);
    if (guildId === "@me" || this.channelNames.has(channelId)) return Promise.resolve();
    const running = this.naming.get(channelId);
    // The lookup already under way carries the name this message wants.
    if (running) return running;
    if (this.namelessChannels.has(channelId)) return Promise.resolve();
    const retryAt = this.nameRetryAt.get(channelId);
    if (retryAt !== undefined && retryAt > Date.now()) return Promise.resolve();
    const lookup = this.lookupChannelName(adapter, threadId, channelId);
    this.naming.set(channelId, lookup);
    return lookup.finally(() => this.naming.delete(channelId));
  }

  private async lookupChannelName(
    adapter: LoadedDiscordAdapter,
    threadId: string,
    channelId: string,
  ) {
    try {
      const info = await adapter.fetchChannelInfo?.(threadId);
      const name = info?.name?.trim();
      if (name) {
        this.channelNames.set(channelId, name);
        this.nameRetryAt.delete(channelId);
        return;
      }
      // Answered, with no name to show.
      this.namelessChannels.add(channelId);
    } catch (error: unknown) {
      // A failed lookup is not a channel without a name: keep the conversation unnamed
      // for now and ask again later.
      this.nameRetryAt.set(channelId, Date.now() + DISCORD_CHANNEL_NAME_RETRY_MS);
      getLogger().warn("discord channel name lookup failed", {
        channelId,
        error: String(error),
      });
    }
  }

  /**
   * Whether this process answers in a room. A direct message is nobody's guild; a
   * guild channel is served only when the operator listed the guild.
   */
  private isAllowedRoom(threadId: string): boolean {
    const { guildId } = decodeDiscordThreadId(threadId);
    if (guildId === "@me") return true;
    if (this.config.allowedGuildIds?.includes(guildId)) return true;
    if (!this.refusedGuilds.has(guildId)) {
      this.refusedGuilds.add(guildId);
      getLogger().warn("discord guild message ignored: guild is not allowed", {
        guildId,
        hint: "add the guild id to DISCORD_ALLOWED_GUILD_IDS to answer in its channels",
      });
    }
    return false;
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
    const deliver = async (adapter: Adapter, threadId: string, message: Message): Promise<void> => {
      // A guild the operator did not name is nobody's to run: the bot is public, so its
      // invite proves nothing about who owns the server.
      if (!this.isAllowedRoom(threadId)) return;
      // Read once per channel before the message is routed: team chat stores the name on the
      // conversation when it first sees the room, and an id is not a name. A second message in
      // the same channel waits on the lookup in flight or is answered from the cache.
      if (this.implementation) {
        await bestEffort(
          "Discord channel name",
          this.rememberChannelName(this.implementation, threadId),
        );
      }
      // A first delivery keeps the SDK's dedupe, so a replayed event stays a no-op. A retry
      // must not: the attempt that failed already claimed that key.
      let first = true;
      const attempt = () => {
        const retrying = !first;
        first = false;
        return retrying && router.routeIncomingMessage
          ? router.routeIncomingMessage.call(chat, adapter, threadId, message, false)
          : chat.handleIncomingMessage(adapter, threadId, message);
      };
      const deliverable = attempt();
      // The first failure reaches the caller at once; the retries run on the shared retry
      // primitive behind it, so a wait honors shutdown and the last failure is logged once.
      let step = 0;
      void deliverable.catch(() =>
        bestEffort(
          "Discord gateway retry delivery",
          retry(
            async () => {
              // Each try waits its own turn of the ladder first: the first attempt has
              // just failed, so retrying it again with no wait would only hammer the sink.
              const wait = DISCORD_GATEWAY_RETRY_DELAYS_MS[step++] ?? 0;
              await abortableDelay(wait, this.stopSignal.signal);
              return attempt();
            },
            {
              attempts: DISCORD_GATEWAY_RETRY_DELAYS_MS.length,
              // The ladder above is the wait; the primitive adds none of its own.
              delayMs: 0,
              // Stopping the listener ends the chain: nothing is left to answer into.
              retryable: () => Boolean(this.listening),
              signal: this.stopSignal.signal,
              onRetry: (error: unknown, retryAttempt: number, delayMs: number) => {
                getLogger().warn("discord inbound processing failed", {
                  error: String(error),
                  attempt: retryAttempt + 2,
                  retryInMs: delayMs,
                });
              },
            },
          ),
        ),
      );
      return deliverable;
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
    this.stopSignal.abort();
    this.window?.abort();
    this.window = undefined;
  }

  private startListening(adapter: LoadedDiscordAdapter) {
    if (this.listening) return;
    if (this.stopSignal.signal.aborted) this.stopSignal = new AbortController();
    const options: WebhookOptions = {
      // No webhook reply is waiting on this work; failures are retried by retryingChat.
      waitUntil: (task) => {
        void bestEffort("Discord gateway delivery", task);
      },
    };
    // The window this run owns; a newer run replaces it, and the old one stops trying.
    let owned: AbortController | undefined;
    /**
     * One start, on a fresh window. A window is always aborted before the one that
     * replaces it: two Gateway clients logged in at once would each receive every
     * message and mint threads the other cannot stop. Keeping the controller per run
     * also keeps abort listeners from piling up on one signal.
     */
    const listen = () => {
      // This run's own window: a newer run replaces it, and the superseded one stops
      // trying rather than aborting the healthy replacement.
      let window: AbortController | undefined;
      const start = async () => {
        if (!this.listening) return;
        owned?.abort();
        window = new AbortController();
        owned = window;
        this.window = window;
        const response = await adapter.startGatewayListener(
          options,
          DISCORD_LISTEN_WINDOW_MS,
          window.signal,
        );
        if (!response.ok) {
          throw new Error(`discord listener did not start: ${response.status}`);
        }
      };
      return bestEffort(
        "Discord gateway start",
        retry(start, {
          attempts: DISCORD_START_RETRY_DELAYS_MS.length + 1,
          delayMs: DISCORD_START_RETRY_DELAYS_MS,
          // Still this run's window, and still listening, before another try.
          retryable: () => Boolean(this.listening) && this.window === window,
          signal: this.stopSignal.signal,
          onRetry: (error: unknown, attempt: number, delayMs: number) => {
            getLogger().warn("discord inbound listener did not start", {
              error: String(error),
              attempt: attempt + 1,
              retryInMs: delayMs,
            });
          },
        }),
      );
    };
    this.listening = setInterval(() => void listen(), DISCORD_LISTEN_WINDOW_MS);
    this.listening.unref?.();
    void listen();
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
