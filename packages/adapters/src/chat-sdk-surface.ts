import { AsyncLocalStorage } from "node:async_hooks";
import { createMemoryState } from "@chat-adapter/state-memory";
import type {
  AdapterContext,
  AdapterDescriptor,
  MessagingCapabilities,
  MessagingInboundEvent,
  MessagingInboundMessage,
  MessagingOutboundStatus,
  MessagingPlatformDescriptor,
  MessagingSendRequest,
  MessagingSendResult,
  MessagingSurface,
} from "@rakazo/adapter-kit";
import type { Adapter, Message, Thread } from "chat";
import { Chat } from "chat";

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
  /** Deterministic 1:1 thread id for platforms without openDM (sendblue). */
  directThreadId?: (address: string) => string;
  /** Delivery-status events the Chat SDK drops (sendblue is_outbound posts). */
  peekStatus?: (payload: unknown) => MessagingOutboundStatus | null;
  /** Group roster addresses from the raw inbound payload, excluding our line. */
  participants?: (raw: unknown) => string[];
  /** Group display name from the raw inbound payload. */
  channelName?: (raw: unknown) => string | null;
}

/**
 * MessagingSurface over the Chat SDK (github.com/vercel/chat): one bot
 * presence across every mounted platform. Orchestration stays upstream —
 * this class only translates between Chat SDK events/calls and the
 * provider-neutral contract.
 */
export class ChatSdkMessagingSurface implements MessagingSurface {
  private readonly chat: Chat<Record<string, Adapter>>;
  private readonly byProvider = new Map<string, MessagingPlatform>();
  private sink: ((event: MessagingInboundEvent) => Promise<void>) | undefined;
  private initialized: Promise<void> | undefined;

  constructor(platforms: MessagingPlatform[], options: { userName?: string } = {}) {
    if (platforms.length === 0) throw new Error("ChatSdkMessagingSurface needs >=1 platform");
    for (const platform of platforms) this.byProvider.set(platform.provider, platform);
    this.chat = new Chat({
      userName: options.userName ?? "rakazo",
      adapters: Object.fromEntries(platforms.map((p) => [p.provider, p.adapter])),
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
    const deliver = async (thread: Thread, message: Message) => {
      const event = this.toInbound(thread, message);
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
    this.chat.onDirectMessage(deliver);
    this.chat.onNewMention(deliver);
    this.chat.onSubscribedMessage(deliver);
    this.chat.onNewMessage(/(?:)/, deliver);
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
    return [...this.byProvider.values()].map((platform) => ({
      provider: platform.provider,
      capabilities: platform.capabilities,
    }));
  }

  onInbound(sink: (event: MessagingInboundEvent) => Promise<void>): void {
    this.sink = sink;
  }

  handleWebhook(provider: string, request: Request): Promise<Response> | null {
    const platform = this.byProvider.get(provider);
    if (!platform) return null;
    return this.dispatchWebhook(platform, request);
  }

  async sendToThread(
    request: MessagingSendRequest,
    _context: AdapterContext,
  ): Promise<MessagingSendResult> {
    await this.ensureInitialized();
    const sent = await this.chat.thread(request.threadId).post(request.body);
    const handle = "id" in sent && typeof sent.id === "string" ? sent.id : "";
    return { handle };
  }

  async openDirectThread(
    provider: string,
    address: string,
    _context: AdapterContext,
  ): Promise<string> {
    const platform = this.byProvider.get(provider);
    if (!platform) throw new Error(`Unknown messaging provider: ${provider}`);
    if (platform.directThreadId) return platform.directThreadId(address);
    await this.ensureInitialized();
    if (!platform.adapter.openDM) {
      throw new Error(`${provider} cannot open direct conversations`);
    }
    return platform.adapter.openDM(address);
  }

  async sendTyping(threadId: string, context: AdapterContext): Promise<void> {
    const platform = this.byProvider.get(providerOfThreadId(threadId));
    if (!platform?.capabilities.typing) return;
    await this.ensureInitialized();
    // The Chat SDK adapter API takes no abort signal, so the underlying
    // request cannot be cancelled — but the caller's wait is still bounded.
    await raceWithSignal(platform.adapter.startTyping(threadId), context.signal);
  }

  private ensureInitialized(): Promise<void> {
    // Webhook handling initializes lazily inside the Chat SDK; proactive
    // sends from job runners need the explicit call.
    this.initialized ??= this.chat.initialize();
    return this.initialized;
  }

  private async dispatchWebhook(platform: MessagingPlatform, request: Request): Promise<Response> {
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
      const adapterResponse = await this.chat.webhooks[platform.provider]!(forwarded, {
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

  private toInbound(thread: Thread, message: Message): MessagingInboundMessage | null {
    if (message.author.isMe || message.author.isSystem) return null;
    const provider = providerOfThreadId(thread.id);
    const platform = this.byProvider.get(provider);
    if (!platform) return null;
    const isDirect = thread.isDM;
    if (!isDirect && !platform.capabilities.groups) return null;
    const fromLabel = message.author.fullName || message.author.userName || null;
    return {
      type: "message",
      provider,
      handle: message.id,
      threadId: thread.id,
      isDirect,
      from: message.author.userId,
      fromLabel: fromLabel === message.author.userId ? null : fromLabel,
      channelName: isDirect ? null : (platform.channelName?.(message.raw) ?? null),
      participants: isDirect ? [] : (platform.participants?.(message.raw) ?? []),
      content: message.text ?? "",
      mediaUrl: message.attachments.find((attachment) => attachment.url)?.url ?? null,
    };
  }
}

export function providerOfThreadId(threadId: string): string {
  return threadId.split(":", 1)[0] ?? "";
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
