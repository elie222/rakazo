import { createMemoryState } from "@chat-adapter/state-memory";
import type {
  AdapterContext,
  AdapterDescriptor,
  MessagingCapabilities,
  MessagingDirectRequest,
  MessagingGroup,
  MessagingGroupRequest,
  MessagingInboundEvent,
  MessagingInboundMessage,
  MessagingProvider,
  MessagingSendResult,
  MessagingTypingRequest,
} from "@rakazo/adapter-kit";
import { Chat, type Adapter as ChatSdkAdapter } from "chat";
import {
  isPhoneSurfaceEnabled,
  type SendBlueConfig,
  SendBlueMessagingProvider,
} from "./sendblue.js";

export type { ChatSdkAdapter };

/**
 * Generic chat-sdk transport configuration. No chat network is baked in: the
 * platform adapter (WhatsApp, Telegram, ...) is constructed elsewhere and
 * selected here by name. Concrete adapters register themselves via
 * `registerChatSdkAdapter` — this module stays adapter-agnostic.
 */
export interface ChatSdkConfig {
  /** chat-sdk platform adapters available to this deployment, keyed by name. */
  adapters: Record<string, ChatSdkAdapter>;
  /** Which registered adapter the deployment's phone line runs on. */
  adapterName: string;
  /** Default bot username across the Chat runtime. */
  userName?: string;
}

export interface ChatSdkEnvironmentValues {
  /** `MESSAGING_CHATSDK_ADAPTER` — registry name of the configured adapter. */
  messagingChatSdkAdapter: string | undefined;
}

const adapterFactories = new Map<string, () => ChatSdkAdapter>();

/**
 * Register a chat-sdk platform adapter factory under its configuration name.
 * Adapters carry vendor credentials and platform packages, so they live in
 * composition roots; the transport bridge only resolves them by name.
 */
export function registerChatSdkAdapter(name: string, create: () => ChatSdkAdapter): void {
  adapterFactories.set(name, create);
}

/** Instantiate a registered adapter, or undefined when the name is unknown. */
export function createChatSdkAdapter(name: string): ChatSdkAdapter | undefined {
  return adapterFactories.get(name)?.();
}

export function chatSdkConfigFromEnv(values: ChatSdkEnvironmentValues): ChatSdkConfig | undefined {
  const adapterName = values.messagingChatSdkAdapter?.trim();
  if (!adapterName) return undefined;
  const adapter = createChatSdkAdapter(adapterName);
  if (!adapter) return undefined;
  return { adapters: { [adapterName]: adapter }, adapterName };
}

/** The named adapter is actually registered, and never live under the test runner. */
export function isChatSdkEnabled(
  config: Partial<ChatSdkConfig> | undefined,
): config is ChatSdkConfig {
  return Boolean(
    config?.adapterName && config.adapters?.[config.adapterName] && !process.env.VITEST,
  );
}

/**
 * One provider per deployment, selected by `MESSAGING_PROVIDER` (default
 * `sendblue`). The chat-sdk branch constructs only when a concrete adapter is
 * registered under `MESSAGING_CHATSDK_ADAPTER`; otherwise the phone surface
 * stays disabled exactly as when SendBlue config is missing.
 */
export function createMessagingProvider(options: {
  provider: string | undefined;
  deploymentModelKey: string | undefined;
  sendBlueConfig: SendBlueConfig;
  chatSdkConfig: ChatSdkConfig | undefined;
}): MessagingProvider | undefined {
  if (options.provider === "chat-sdk") {
    if (!isChatSdkEnabled(options.chatSdkConfig)) return undefined;
    if (!options.deploymentModelKey) return undefined;
    return new ChatSdkMessagingProvider(options.chatSdkConfig);
  }
  return isPhoneSurfaceEnabled(options.sendBlueConfig, options.deploymentModelKey)
    ? new SendBlueMessagingProvider(options.sendBlueConfig)
    : undefined;
}

/**
 * Structural shape of a chat-sdk normalized `Message`. Duck-typed like the
 * SendBlue parser's payload so the mapping stays unit-testable and stable
 * across chat-sdk minor versions.
 */
export interface ChatSdkInboundInput {
  id?: unknown;
  text?: unknown;
  threadId?: unknown;
  author?: { userId?: unknown } | undefined;
  attachments?: ReadonlyArray<{ url?: unknown } | undefined> | undefined;
}

/**
 * Map a chat-sdk normalized inbound message onto the neutral event. The
 * sender identifier passes through untouched: phone-number normalization
 * (wa_id → E.164, BSUID handling) is platform-specific and belongs to the
 * adapter layer, not this transport. Group identity is not derivable from a
 * DM message, and group support awaits the still-open adapter decision.
 */
export function parseChatSdkInbound(
  message: ChatSdkInboundInput | null | undefined,
): MessagingInboundEvent | null {
  if (typeof message !== "object" || message === null) return null;
  if (typeof message.id !== "string" || !message.id) return null;
  if (typeof message.author?.userId !== "string" || !message.author.userId) return null;
  const mediaUrl = (message.attachments ?? []).find((attachment): attachment is { url: string } => {
    return Boolean(attachment) && typeof attachment?.url === "string" && attachment.url !== "";
  });
  return {
    type: "message",
    handle: message.id,
    fromNumber: message.author.userId,
    groupId: null,
    groupName: null,
    participants: [],
    content: typeof message.text === "string" ? message.text : "",
    mediaUrl: mediaUrl?.url ?? null,
  };
}

/**
 * chat-sdk-backed `MessagingProvider`. The `Chat` runtime is constructed with
 * whatever adapter the configuration selected; verification, payload parsing,
 * and platform auth live inside chat-sdk and its adapter, so this class only
 * bridges between chat-sdk threads/messages and the neutral surface.
 */
export class ChatSdkMessagingProvider implements MessagingProvider {
  private readonly bot: Chat;
  private readonly adapter: ChatSdkAdapter;
  private readonly adapterName: string;
  private initialized = false;
  private inboundHandler?: (event: MessagingInboundMessage) => Promise<void>;

  constructor(config: ChatSdkConfig) {
    const adapter = config.adapters[config.adapterName];
    if (!adapter) {
      throw new Error(`chat-sdk adapter "${config.adapterName}" is not configured`);
    }
    this.adapter = adapter;
    this.adapterName = config.adapterName;
    this.bot = new Chat({
      userName: config.userName ?? "rakazo",
      adapters: config.adapters,
      state: createMemoryState(),
      // rakazo's run/job model owns ordering; dropping overlapping inbound
      // messages would lose texts the outbox already mirrors.
      concurrency: "concurrent",
    });
    // Inbound DMs flow: adapter webhook → chat-sdk verification/parse →
    // onDirectMessage → parseChatSdkInbound → the handler wired at the
    // composition root. chat-sdk filters self-messages before dispatch.
    this.bot.onDirectMessage(async (_thread, message) => {
      const event = parseChatSdkInbound(message);
      if (event?.type === "message") await this.inboundHandler?.(event);
    });
  }

  /**
   * Initialize the Chat runtime (connects the state adapter and calls the
   * adapter's `initialize`). Webhook handling initializes lazily inside
   * chat-sdk; calling this at startup fails fast on a misconfigured adapter.
   */
  async initialize(): Promise<void> {
    if (!this.initialized) {
      await this.bot.initialize();
      this.initialized = true;
    }
  }

  /**
   * Wire the composition root's inbound handler. chat-sdk dispatches only
   * DMs here; group events require the adapter decision that is still open.
   */
  onInbound(handler: (event: MessagingInboundMessage) => Promise<void>): void {
    this.inboundHandler = handler;
  }

  /**
   * Handle an inbound webhook request for the configured adapter. Signature
   * verification and parsing happen inside chat-sdk; the API route delegates
   * the raw request (GET challenge and POST events) unchanged.
   */
  handleWebhook(request: Request): Promise<Response> {
    const handler = this.bot.webhooks[this.adapterName];
    if (!handler) {
      throw new Error(`chat-sdk adapter "${this.adapterName}" exposes no webhook handler`);
    }
    return handler(request);
  }

  describe(): AdapterDescriptor<MessagingCapabilities> {
    return {
      id: `chatsdk-${this.adapterName}`,
      contractVersion: "1",
      adapterVersion: "0.1.0",
      // chat-sdk's Adapter interface carries no capability metadata, so
      // capabilities are derived from the configured adapter instance: the
      // optional `openDM` method is the only honest signal for direct sends,
      // `startTyping` for typing. chat-sdk has no cross-adapter group-send
      // surface, so groups stay false until an adapter provides one.
      capabilities: {
        direct: typeof this.adapter.openDM === "function",
        groups: false,
        typing: typeof this.adapter.startTyping === "function",
      },
    };
  }

  async sendDirect(
    request: MessagingDirectRequest,
    _context: AdapterContext,
  ): Promise<MessagingSendResult> {
    await this.initialize();
    const threadId = await this.openDM(request.to);
    const sent = await this.bot.thread(threadId).post(request.body);
    return { handle: sent.id };
  }

  async sendTypingIndicator(
    request: MessagingTypingRequest,
    _context: AdapterContext,
  ): Promise<void> {
    await this.initialize();
    const threadId = await this.openDM(request.to);
    // Best effort by contract: chat-sdk no-ops on platforms without typing.
    await this.bot.thread(threadId).startTyping();
  }

  /**
   * Groups are not part of the generic chat-sdk surface; capabilities report
   * false so the outbox drain never routes group rows here.
   */
  async sendGroup(
    _request: MessagingGroupRequest,
    _context: AdapterContext,
  ): Promise<MessagingSendResult> {
    throw new Error(`chat-sdk adapter "${this.adapterName}" does not support group sends`);
  }

  async getGroup(_groupId: string, _context: AdapterContext): Promise<MessagingGroup> {
    throw new Error(`chat-sdk adapter "${this.adapterName}" does not support group lookups`);
  }

  private openDM(to: string): Promise<string> {
    const openDM = this.adapter.openDM;
    if (!openDM) {
      throw new Error(`chat-sdk adapter "${this.adapterName}" does not support direct messages`);
    }
    return openDM.call(this.adapter, to);
  }
}
