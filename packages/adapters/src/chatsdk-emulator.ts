import {
  type AdapterPostableMessage,
  BaseFormatConverter,
  type ChatInstance,
  type Adapter as ChatSdkAdapter,
  type FetchOptions,
  type FetchResult,
  type FormattedContent,
  Message,
  parseMarkdown,
  type RawMessage,
  stringifyMarkdown,
  type ThreadInfo,
} from "chat";

interface EmulatedThread {
  userId: string;
}

interface EmulatedSend {
  to: string;
  body: string;
  handle: string;
}

export interface ChatSdkEmulatorInboundInput {
  from: string;
  text: string;
  /** Fixed handle to exercise replay/dedupe behavior. */
  handle?: string;
}

class PlainTextConverter extends BaseFormatConverter {
  toAst(platformText: string): ReturnType<typeof parseMarkdown> {
    return parseMarkdown(platformText);
  }

  fromAst(ast: FormattedContent): string {
    return stringifyMarkdown(ast);
  }
}

/**
 * Deterministic in-memory chat network for the chat-sdk transport. The
 * emulator IS the chat-sdk adapter: no real platform package is needed, so
 * the whole bridge — outbound sends, typing, inbound delivery through the
 * Chat runtime's DM dispatch — runs offline over injected configuration.
 */
export class ChatSdkEmulator implements ChatSdkAdapter {
  readonly name = "emulated";
  readonly userName = "rakazo-emulated";
  readonly sent: EmulatedSend[] = [];
  readonly typingIndicators: string[] = [];
  private handleCounter = 0;
  private failRemaining = 0;
  private chat: ChatInstance | null = null;
  private readonly converter = new PlainTextConverter();

  // --- chat-sdk Adapter surface -------------------------------------------------

  async initialize(chat: ChatInstance): Promise<void> {
    this.chat = chat;
  }

  encodeThreadId(data: EmulatedThread): string {
    return `emulated:dm:${data.userId}`;
  }

  decodeThreadId(threadId: string): EmulatedThread {
    const parts = threadId.split(":");
    if (parts.length !== 3 || parts[0] !== "emulated" || parts[1] !== "dm") {
      throw new Error(`Invalid emulated thread ID: ${threadId}`);
    }
    return { userId: parts[2]! };
  }

  channelIdFromThreadId(threadId: string): string {
    const { userId } = this.decodeThreadId(threadId);
    return `emulated:dm:${userId}`;
  }

  async openDM(userId: string): Promise<string> {
    return this.encodeThreadId({ userId });
  }

  async postMessage(
    threadId: string,
    message: AdapterPostableMessage,
  ): Promise<RawMessage<unknown>> {
    if (this.failRemaining > 0) {
      this.failRemaining -= 1;
      throw new Error("emulated chat network failure");
    }
    const body = this.converter.renderPostable(message);
    const handle = this.nextHandle();
    const { userId } = this.decodeThreadId(threadId);
    this.sent.push({ to: userId, body, handle });
    return { raw: { handle }, id: handle, threadId };
  }

  isDM(): boolean {
    // The emulated network only carries DMs; group support awaits the
    // adapter decision that is still open.
    return true;
  }

  async startTyping(threadId: string): Promise<void> {
    const { userId } = this.decodeThreadId(threadId);
    this.typingIndicators.push(userId);
  }

  parseMessage(raw: { id: string; threadId: string; text: string; from: string }): Message {
    return new Message({
      id: raw.id,
      threadId: raw.threadId,
      text: raw.text,
      formatted: parseMarkdown(raw.text),
      raw,
      author: {
        userId: raw.from,
        userName: raw.from,
        fullName: raw.from,
        isBot: false,
        isMe: false,
      },
      metadata: { dateSent: new Date(), edited: false },
      attachments: [],
    });
  }

  async fetchMessages(_threadId: string, _options?: FetchOptions): Promise<FetchResult<unknown>> {
    return { messages: [], nextCursor: undefined };
  }

  async fetchThread(threadId: string): Promise<ThreadInfo> {
    return {
      channelId: threadId,
      id: threadId,
      isDM: true,
      metadata: {},
    };
  }

  renderFormatted(content: FormattedContent): string {
    return stringifyMarkdown(content);
  }

  async handleWebhook(): Promise<Response> {
    // The emulated network has no HTTP transport; inbound arrives via
    // deliverInbound. Real adapters own webhook verification and parsing.
    return new Response("emulated adapter has no webhook transport", { status: 501 });
  }

  async addReaction(): Promise<void> {}
  async removeReaction(): Promise<void> {}
  async deleteMessage(): Promise<void> {}

  async editMessage(threadId: string, messageId: string): Promise<RawMessage<unknown>> {
    return { raw: {}, id: messageId, threadId };
  }

  // --- test controls ------------------------------------------------------------

  /** Next N postMessage calls fail, exercising the drain's retry path. */
  failNextSends(count: number): void {
    this.failRemaining = count;
  }

  /**
   * Deliver an inbound DM through the Chat runtime's normal dispatch, exactly
   * as a verified platform webhook would: onDirectMessage handlers fire and
   * the provider's inbound mapping sees a normalized chat-sdk Message.
   */
  async deliverInbound(input: ChatSdkEmulatorInboundInput): Promise<void> {
    if (!this.chat) {
      throw new Error("emulated network is not attached to a Chat runtime yet");
    }
    const threadId = this.encodeThreadId({ userId: input.from });
    const message = this.parseMessage({
      id: input.handle ?? this.nextHandle(),
      threadId,
      text: input.text,
      from: input.from,
    });
    await this.chat.processMessage(this, threadId, message);
  }

  nextHandle(): string {
    this.handleCounter += 1;
    return `emulated-msg-${this.handleCounter}`;
  }
}
