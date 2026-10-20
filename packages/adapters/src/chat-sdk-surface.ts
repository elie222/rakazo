import { AsyncLocalStorage } from "node:async_hooks";
import { createMemoryState } from "@chat-adapter/state-memory";
import type {
  AdapterContext,
  AdapterDescriptor,
  MessagingCapabilities,
  MessagingInboundAttachment,
  MessagingInboundEvent,
  MessagingInboundMessage,
  MessagingOutboundStatus,
  MessagingPlatformDescriptor,
  MessagingReceipt,
  MessagingSendRequest,
  MessagingSendResult,
  MessagingSurface,
} from "@rakazo/adapter-kit";
import type { Adapter, Message, Thread } from "chat";
import { Chat, isLinkNode, text, toPlainText, walkAst } from "chat";

/** Per-webhook drain of Chat SDK waitUntil work + inbound sink failures. */
const webhookDrain = new AsyncLocalStorage<{
  pending: Promise<unknown>[];
  failed: boolean;
}>();

/** Inbound webhook bodies larger than this are rejected before parsing. */
export const MESSAGING_WEBHOOK_MAX_BODY_BYTES = 256 * 1024;

/**
 * One messaging platform mounted on the surface. The Chat SDK adapter owns
 * webhook verification, payload translation, and platform API calls; the
 * extra hooks cover the few per-platform facts the SDK does not surface.
 */
export interface MessagingPlatform {
  provider: string;
  capabilities: MessagingCapabilities;
  adapter: Adapter;
  /**
   * The adapter's own thread-id prefix when it differs from `provider`, so
   * one adapter type can mount more than once (one Telegram bot per space:
   * "telegram-work"). Rakazo only ever sees `provider`-prefixed thread ids;
   * the adapter keeps its native ones. Defaults to `provider`.
   */
  adapterName?: string;
  /** Deterministic 1:1 thread id for platforms without openDM (sendblue). */
  directThreadId?: (address: string) => string;
  /** Delivery-status events the Chat SDK drops (sendblue is_outbound posts). */
  peekStatus?: (payload: unknown) => MessagingOutboundStatus | null;
  /** Group roster addresses from the raw inbound payload, excluding our line. */
  participants?: (raw: unknown) => string[];
  /** Group display name from the raw inbound payload. */
  channelName?: (raw: unknown) => string | null;
  /** User-facing transport carried by the raw message when it differs from the provider. */
  transport?: (raw: unknown) => string | null;
  /**
   * Optional team-room enrichment (workspace id, mention/ambient kind, bot
   * sender, reply thread) derived from the raw platform payload.
   */
  enrichTeamRoom?: (
    raw: unknown,
    base: MessagingInboundMessage,
  ) => Partial<MessagingInboundMessage>;
}

/** One mounted platform with its own Chat SDK instance. */
interface MountedPlatform {
  platform: MessagingPlatform;
  /** The adapter's native thread-id prefix (see MessagingPlatform.adapterName). */
  adapterName: string;
  chat: Chat<Record<string, Adapter>>;
}

/**
 * MessagingSurface over the Chat SDK (github.com/vercel/chat): one bot
 * presence per mounted platform. Orchestration stays upstream — this class
 * only translates between Chat SDK events/calls and the provider-neutral
 * contract.
 *
 * Each platform gets its own Chat instance: the SDK routes thread ids by
 * their adapter-name prefix, so two adapters of the same type (two Telegram
 * bots, both minting "telegram:<chatId>") cannot share one instance. The
 * surface rewrites that prefix to the platform's provider at the boundary.
 */
export class ChatSdkMessagingSurface implements MessagingSurface {
  private readonly byProvider = new Map<string, MountedPlatform>();
  private sink: ((event: MessagingInboundEvent) => Promise<void>) | undefined;
  private initialized: Promise<void> | undefined;

  constructor(platforms: MessagingPlatform[], options: { userName?: string } = {}) {
    if (platforms.length === 0) throw new Error("ChatSdkMessagingSurface needs >=1 platform");
    for (const platform of platforms) {
      if (this.byProvider.has(platform.provider)) {
        throw new Error(`Duplicate messaging provider: ${platform.provider}`);
      }
      const adapterName = platform.adapterName ?? platform.provider;
      const chat = new Chat({
        userName: options.userName ?? "rakazo",
        adapters: { [adapterName]: platform.adapter },
        state: createMemoryState(),
        // The SDK default ("drop") takes a per-conversation lock and discards
        // any message that arrives while it is held — and the LockError is
        // swallowed into waitUntil, so the webhook still ACKs 200 and the
        // vendor never retries. Two texts in quick succession would lose the
        // second. Each inbound message already runs inside its own webhook's
        // waitUntil task, so process them independently and let the per-message
        // client nonce downstream handle replay.
        concurrency: "concurrent",
      });
      const mounted: MountedPlatform = { platform, adapterName, chat };
      this.byProvider.set(platform.provider, mounted);
      const deliver = async (thread: Thread, message: Message) => {
        const event = this.toInbound(mounted, thread.id, thread.isDM, message);
        if (!event) return;
        try {
          await this.sink?.(event);
        } catch (error) {
          // processMessage hands waitUntil a swallowed promise, so track sink
          // failures here and turn them into HTTP 5xx after the drain.
          const drain = webhookDrain.getStore();
          if (drain) drain.failed = true;
          throw error;
        }
      };
      // Priority routing makes these disjoint: DMs, then @-mentions in
      // unsubscribed threads, then the catch-all pattern for everything else.
      // Subscribed threads skip the catch-all and only fire onSubscribedMessage
      // (chat SDK docs / dispatchToHandlersWithSignal); register deliver there too.
      chat.onDirectMessage(deliver);
      chat.onNewMention(deliver);
      chat.onSubscribedMessage(deliver);
      chat.onNewMessage(/(?:)/, deliver);
    }
  }

  describe(): AdapterDescriptor<{ providers: string[] }> {
    return {
      id: "chat-sdk",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { providers: [...this.byProvider.keys()] },
    };
  }

  platforms(): MessagingPlatformDescriptor[] {
    return [...this.byProvider.values()].map(({ platform }) => ({
      provider: platform.provider,
      capabilities: platform.capabilities,
    }));
  }

  onInbound(sink: (event: MessagingInboundEvent) => Promise<void>): void {
    this.sink = sink;
  }

  handleWebhook(provider: string, request: Request): Promise<Response> | null {
    const mounted = this.byProvider.get(provider);
    if (!mounted) return null;
    return this.dispatchWebhook(mounted, request);
  }

  async sendToThread(
    request: MessagingSendRequest,
    _context: AdapterContext,
  ): Promise<MessagingSendResult> {
    const mounted = this.mountedForThread(request.threadId);
    await this.ensureInitialized();
    // Telegram converts Markdown and retries parse errors as plain text. Keep
    // other adapters' existing payloads (Slack markdown_text has a lower limit).
    const message = mounted.adapterName === "telegram" ? { markdown: request.body } : request.body;
    const sent = await mounted.chat
      .thread(toAdapterThreadId(mounted, request.threadId))
      .post(message);
    const handle = "id" in sent && typeof sent.id === "string" ? sent.id : "";
    return { handle };
  }

  async openDirectThread(
    provider: string,
    address: string,
    _context: AdapterContext,
  ): Promise<string> {
    const mounted = this.byProvider.get(provider);
    if (!mounted) throw new Error(`Unknown messaging provider: ${provider}`);
    const { platform } = mounted;
    if (platform.directThreadId) return platform.directThreadId(address);
    await this.ensureInitialized();
    if (!platform.adapter.openDM) {
      throw new Error(`${provider} cannot open direct conversations`);
    }
    return toProviderThreadId(mounted, await platform.adapter.openDM(address));
  }

  async acknowledge(threadId: string, handle: string, context: AdapterContext): Promise<void> {
    const mounted = this.byProvider.get(providerOfThreadId(threadId));
    const receipt = mounted?.platform.capabilities.receipt;
    if (!mounted || !receipt) return;
    await this.ensureInitialized();
    const { platform } = mounted;
    const adapterThreadId = toAdapterThreadId(mounted, threadId);
    const sends: Record<MessagingReceipt, () => Promise<void>> = {
      typing: () => platform.adapter.startTyping(adapterThreadId),
      reaction: () => platform.adapter.addReaction(adapterThreadId, handle, "eyes"),
    };
    // The Chat SDK adapter API takes no abort signal, so the underlying
    // request cannot be cancelled — but the caller's wait is still bounded.
    await raceWithSignal(sends[receipt](), context.signal);
  }

  async fetchThreadHistory(
    threadId: string,
    options: { before: string; limit: number },
    context: AdapterContext,
  ): Promise<MessagingInboundMessage[]> {
    const mounted = this.byProvider.get(providerOfThreadId(threadId));
    if (!mounted) return [];
    await this.ensureInitialized();
    const adapterThreadId = toAdapterThreadId(mounted, threadId);
    const fetched = await raceWithSignal(
      mounted.platform.adapter.fetchMessages(adapterThreadId, {
        limit: options.limit + 1,
        direction: "backward",
      }),
      context.signal,
    );
    const end = fetched.messages.findIndex((message) => message.id === options.before);
    if (end < 0) return [];
    const isDirect = mounted.platform.adapter.isDM?.(adapterThreadId) ?? false;
    return fetched.messages
      .slice(0, end)
      .slice(-options.limit)
      .flatMap((message) => this.toInbound(mounted, adapterThreadId, isDirect, message) ?? []);
  }

  /**
   * Proactively start the underlying Chat SDK instance. Webhook handling
   * and outbound sends already trigger this lazily (see ensureInitialized
   * below), but a polling-mode adapter (Telegram in "auto" mode with no
   * public webhook URL registered) needs its pull loop running before the
   * first inbound message can ever arrive, so long-running hosts call this
   * explicitly at startup instead of waiting on the first send.
   */
  async initialize(): Promise<void> {
    await this.ensureInitialized();
  }

  /**
   * Stop Telegram getUpdates before exit. Chat.shutdown() only calls
   * adapter.disconnect(), which Telegram does not implement.
   */
  async shutdown(): Promise<void> {
    const pending = this.initialized;
    this.initialized = undefined;
    if (pending) await pending.catch(() => undefined);
    await this.stopPollingAdapters();
    await this.shutdownChats();
  }

  private ensureInitialized(): Promise<void> {
    // Webhook handling initializes lazily inside the Chat SDK; proactive
    // sends from job runners need the explicit call. Chat keeps a rejected
    // initPromise until shutdown(), so clear that before allowing a retry.
    if (!this.initialized) {
      const chats = [...this.byProvider.values()].map(({ chat }) => chat.initialize());
      this.initialized = Promise.all(chats).then(
        () => undefined,
        async (error: unknown) => {
          try {
            // Telegram may already be polling if another platform's
            // initialize failed after Telegram's started getUpdates.
            await Promise.allSettled(chats);
            await this.stopPollingAdapters();
            await this.shutdownChats();
          } finally {
            this.initialized = undefined;
          }
          throw error;
        },
      );
    }
    return this.initialized;
  }

  private async stopPollingAdapters(): Promise<void> {
    for (const { platform } of this.byProvider.values()) {
      const adapter = platform.adapter as { stopPolling?: () => Promise<void> };
      await adapter.stopPolling?.().catch(() => undefined);
    }
  }

  private async shutdownChats(): Promise<void> {
    for (const { chat } of this.byProvider.values()) {
      // Best-effort: also resets Chat's cached init failure.
      await (chat as { shutdown?: () => Promise<void> }).shutdown?.().catch(() => undefined);
    }
  }

  private mountedForThread(threadId: string): MountedPlatform {
    const mounted = this.byProvider.get(providerOfThreadId(threadId));
    if (!mounted) throw new Error(`No messaging provider mounted for thread ${threadId}`);
    return mounted;
  }

  private async dispatchWebhook(mounted: MountedPlatform, request: Request): Promise<Response> {
    const { platform, adapterName, chat } = mounted;
    const declared = Number(request.headers.get("content-length") ?? 0);
    if (declared > MESSAGING_WEBHOOK_MAX_BODY_BYTES) {
      return new Response("Payload too large", { status: 413 });
    }
    const hasBody = request.method !== "GET" && request.method !== "HEAD";
    const body = hasBody ? await readBoundedText(request, MESSAGING_WEBHOOK_MAX_BODY_BYTES) : "";
    if (body === null) {
      return new Response("Payload too large", { status: 413 });
    }
    const forwarded = hasBody
      ? new Request(request.url, { method: request.method, headers: request.headers, body })
      : request;
    // Real Chat SDK adapters fire processMessage without awaiting it; they
    // only register the work via waitUntil. Drain that work before ACKing so
    // a vendor 200 cannot race ahead of provision/enqueue, and surface sink
    // failures as 5xx so the vendor retries.
    const drain = { pending: [] as Promise<unknown>[], failed: false };
    const response = await webhookDrain.run(drain, async () => {
      const adapterResponse = await chat.webhooks[adapterName]!(forwarded, {
        waitUntil: (task) => {
          drain.pending.push(task);
        },
      });
      await Promise.all(drain.pending);
      return adapterResponse;
    });
    if (drain.failed) {
      return new Response("Inbound processing failed", { status: 500 });
    }
    // Status peeking runs only after the adapter verified and accepted the
    // request — a forged webhook must not be able to flip outbox rows.
    if (platform.peekStatus && response.status < 300 && body) {
      const status = parseStatus(platform, body);
      if (status) await this.sink?.(status);
    }
    return response;
  }

  private toInbound(
    mounted: MountedPlatform,
    threadId: string,
    isDirect: boolean,
    message: Message,
  ): MessagingInboundMessage | null {
    if (message.author.isMe || message.author.isSystem) return null;
    const { platform } = mounted;
    if (!isDirect && !platform.capabilities.groups) return null;
    const fromLabel = message.author.fullName || message.author.userName || null;
    const transport = platform.transport?.(message.raw) ?? null;
    const attachments = inboundAttachments(message);
    const base: MessagingInboundMessage = {
      type: "message",
      provider: platform.provider,
      ...(transport ? { transport } : {}),
      handle: message.id,
      threadId: toProviderThreadId(mounted, threadId),
      isDirect,
      from: message.author.userId,
      fromLabel: fromLabel === message.author.userId ? null : fromLabel,
      channelName: isDirect ? null : (platform.channelName?.(message.raw) ?? null),
      participants: isDirect ? [] : (platform.participants?.(message.raw) ?? []),
      content: [
        plainTextWithLinks(message),
        ...(attachments.length
          ? message.attachments
              .filter((file) => !file.fetchData && file.url)
              .map((file) => file.url)
          : []),
      ]
        .filter(Boolean)
        .join("\n"),
      mediaUrl: message.attachments.find((attachment) => attachment.url)?.url ?? null,
      ...(attachments.length ? { attachments } : {}),
      ...(!isDirect && message.isMention ? { mentionsBot: true } : {}),
    };
    const enrichment = platform.enrichTeamRoom?.(message.raw, base) ?? {};
    return { ...base, ...enrichment };
  }
}

function inboundAttachments(message: Message): MessagingInboundAttachment[] {
  return message.attachments.flatMap((attachment) => {
    const fetchData = attachment.fetchData;
    if (!fetchData) return [];
    return [
      {
        name: attachment.name || attachment.type,
        mimeType: attachment.mimeType ?? "",
        ...(attachment.size !== undefined ? { size: attachment.size } : {}),
        fetch: async () => new Uint8Array(await fetchData()),
      },
    ];
  });
}

/**
 * The SDK's message.text keeps only a link's label, so a Slack link labelled
 * `example.com/projects/…` reaches the model without its target.
 */
function plainTextWithLinks(message: Message): string {
  let addedTarget = false;
  const ast = walkAst(structuredClone(message.formatted), (node) => {
    if (!isLinkNode(node)) return node;
    const label = toPlainText({ type: "root", children: node.children }).trim();
    const bare = node.url.replace(/^(?:https?:\/\/|mailto:)/, "");
    if (!label) {
      addedTarget = true;
      return text(node.url);
    }
    if (label === node.url || label === bare || label === bare.replace(/\/$/, ""))
      return text(label);
    addedTarget = true;
    return text(`${label} (${node.url})`);
  });
  return addedTarget ? toPlainText(ast) : (message.text ?? "");
}

export function providerOfThreadId(threadId: string): string {
  return threadId.split(":", 1)[0] ?? "";
}

/** Adapter-native thread id ("telegram:42") → Rakazo thread id ("telegram-work:42"). */
function toProviderThreadId(mounted: MountedPlatform, threadId: string): string {
  const { provider } = mounted.platform;
  if (mounted.adapterName === provider) return threadId;
  const prefix = `${mounted.adapterName}:`;
  return threadId.startsWith(prefix) ? `${provider}:${threadId.slice(prefix.length)}` : threadId;
}

/** Rakazo thread id → the id the platform's adapter and Chat instance expect. */
function toAdapterThreadId(mounted: MountedPlatform, threadId: string): string {
  const { provider } = mounted.platform;
  if (mounted.adapterName === provider) return threadId;
  const prefix = `${provider}:`;
  return threadId.startsWith(prefix)
    ? `${mounted.adapterName}:${threadId.slice(prefix.length)}`
    : threadId;
}

function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(signal.reason ?? new Error("Aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      // The abandoned branch must not surface as an unhandled rejection.
      promise.catch(() => undefined);
      reject(signal.reason ?? new Error("Aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/**
 * Read the body incrementally so an unauthenticated chunked request (no
 * trustworthy Content-Length) is cut off at the cap instead of being
 * buffered whole. Returns null once the cap is exceeded.
 */
async function readBoundedText(request: Request, maxBytes: number): Promise<string | null> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function parseStatus(platform: MessagingPlatform, body: string): MessagingOutboundStatus | null {
  try {
    return platform.peekStatus?.(JSON.parse(body)) ?? null;
  } catch {
    return null;
  }
}
