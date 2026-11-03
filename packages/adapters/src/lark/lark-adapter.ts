import { createHash, timingSafeEqual } from "node:crypto";
import type * as LarkSdk from "@larksuiteoapi/node-sdk";
import type { Adapter, AdapterPostableMessage, ChatInstance, WebhookOptions } from "chat";
import { Message, parseMarkdown } from "chat";
import type { LarkAdapterConfig } from "./lazy-adapter.js";
import { LarkAdapterBase } from "./lazy-adapter.js";
import type { LarkTextPart } from "./text-parts.js";
import { setLarkTextParts } from "./text-parts.js";

interface WebhookPayload {
  encrypt?: string;
  type?: string;
  token?: string;
  challenge?: string;
  header?: { token?: string; event_type?: string };
  event?: LarkMessageEvent;
}

interface LarkMessageEvent {
  sender: { sender_type: string; sender_id?: { open_id?: string } };
  message: {
    message_id: string;
    chat_id: string;
    chat_type: string;
    thread_id?: string;
    create_time: string;
    update_time?: string;
    message_type: string;
    content: string;
    mentions?: { key: string; name: string; id: { open_id?: string } }[];
  };
}

/** Webhook-only direct messaging; the SDK owns HTTP, domains and tenant tokens. */
export class LarkAdapter extends LarkAdapterBase implements Adapter {
  readonly name = "lark";
  private readonly client: LarkSdk.Client;
  private chat: ChatInstance | undefined;
  private botId = "";
  private botName = "lark";
  private readonly directChats = new Set<string>();
  private readonly users = new Map<string, string>();

  constructor(
    readonly config: LarkAdapterConfig,
    private readonly sdk: typeof LarkSdk,
  ) {
    super();
    this.client = new sdk.Client({
      appId: config.appId,
      appSecret: config.appSecret,
      domain: config.domain,
      loggerLevel: sdk.LoggerLevel.error,
      ...(config.httpInstance ? { httpInstance: config.httpInstance } : {}),
    });
  }
  get userName() {
    return this.botName;
  }
  get botUserId() {
    return this.botId;
  }
  async initialize(chat: ChatInstance) {
    this.chat = chat;
    const info = checked(
      await this.client.request<{
        code?: number;
        msg?: string;
        bot?: { open_id?: string; app_name?: string };
      }>({ method: "GET", url: "/open-apis/bot/v3/info" }),
    );
    this.botId = info.bot?.open_id ?? "";
    this.botName = info.bot?.app_name ?? "lark";
  }
  async disconnect() {
    this.directChats.clear();
    this.users.clear();
  }

  async handleWebhook(request: Request, options?: WebhookOptions): Promise<Response> {
    const body = await request.text();
    let payload: WebhookPayload | null;
    try {
      payload = JSON.parse(body);
    } catch {
      return new Response("Invalid JSON", { status: 400 });
    }
    if (!payload || typeof payload !== "object")
      return new Response("Invalid JSON", { status: 400 });
    if (this.config.encryptKey) {
      const timestamp = request.headers.get("x-lark-request-timestamp");
      const nonce = request.headers.get("x-lark-request-nonce");
      const signature = request.headers.get("x-lark-signature");
      const expected = createHash("sha256")
        .update((timestamp ?? "") + (nonce ?? "") + this.config.encryptKey + body)
        .digest("hex");
      if (!timestamp || !nonce || !equal(signature ?? "", expected)) return forbidden();
    }
    if (payload.encrypt) {
      if (!this.config.encryptKey) return forbidden();
      try {
        payload = JSON.parse(
          new this.sdk.AESCipher(this.config.encryptKey).decrypt(payload.encrypt),
        );
      } catch {
        return forbidden();
      }
    }
    if (!payload || typeof payload !== "object") return forbidden();
    const token = payload.header?.token ?? payload.token;
    if (typeof token !== "string" || !equal(token, this.config.verificationToken))
      return forbidden();
    if (payload.type === "url_verification") return Response.json({ challenge: payload.challenge });
    if (payload.header?.event_type !== "im.message.receive_v1") return Response.json({});
    const raw = payload.event as LarkMessageEvent;
    if (!raw?.message || !raw.sender) return Response.json({});
    if (raw.message.chat_type !== "p2p" || raw.sender.sender_id?.open_id === this.botId)
      return Response.json({});
    this.directChats.add(raw.message.chat_id);
    if (!this.chat) throw new Error("Lark adapter is not initialized");
    this.chat.processMessage(
      this,
      this.encodeThreadId({
        chatId: raw.message.chat_id,
        ...(raw.message.thread_id ? { threadId: raw.message.thread_id } : {}),
      }),
      async () => {
        const message = this.parseMessage(raw);
        const id = message.author.userId;
        let name = this.users.get(id);
        if (!name && id) {
          try {
            name = checked(
              await this.client.contact.user.get({
                path: { user_id: id },
                params: { user_id_type: "open_id" },
              }),
            ).data?.user?.name;
            if (name) this.users.set(id, name);
          } catch {
            /* Missing contact permissions must not block inbound delivery. */
          }
        }
        if (name) {
          message.author.fullName = name;
          message.author.userName = name;
        }
        return message;
      },
      options,
    );
    return Response.json({});
  }

  parseMessage(raw: unknown) {
    const event = raw as LarkMessageEvent;
    const msg = event.message;
    const id = event.sender.sender_id?.open_id ?? "";
    const { text, parts } = inboundText(msg.content, msg.message_type, msg.mentions ?? []);
    const formatted = parseMarkdown(text);
    if (parts) setLarkTextParts(formatted, parts);
    const name = this.users.get(id) ?? id;
    return new Message({
      id: msg.message_id,
      threadId: this.encodeThreadId({
        chatId: msg.chat_id,
        ...(msg.thread_id ? { threadId: msg.thread_id } : {}),
      }),
      text,
      formatted,
      raw,
      author: {
        userId: id || "unknown",
        userName: name,
        fullName: name,
        isBot: event.sender.sender_type === "bot",
        isMe: id === this.botId,
      },
      attachments: [],
      isMention:
        msg.chat_type === "p2p" ||
        (msg.mentions?.some((mention) => mention.id.open_id === this.botId) ?? false),
      metadata: {
        dateSent: new Date(Number(msg.create_time)),
        edited: msg.update_time != null && msg.update_time !== msg.create_time,
      },
    });
  }
  isDM(threadId: string) {
    return this.directChats.has(this.decodeThreadId(threadId).chatId);
  }
  async openDM(userId: string) {
    const result = checked(
      await this.client.im.chat.create({
        data: { chat_mode: "p2p", user_id_list: [userId] },
        params: { user_id_type: "open_id" },
      }),
    );
    const chatId = result.data?.chat_id;
    if (!chatId) throw new Error("Lark did not return a direct chat ID");
    this.directChats.add(chatId);
    return this.encodeThreadId({ chatId });
  }
  private payload(message: AdapterPostableMessage): { msgType: string; content: string } {
    const markdown =
      typeof message === "string"
        ? null
        : "markdown" in message
          ? message.markdown
          : "ast" in message
            ? this.renderFormatted(message.ast)
            : null;
    if (markdown) {
      // Rich text accepts a whole Markdown body as one md block.
      return {
        msgType: "post",
        content: JSON.stringify({ zh_cn: { content: [[{ tag: "md", text: markdown }]] } }),
      };
    }
    const text = typeof message === "string" ? message : "raw" in message ? message.raw : "";
    if (typeof text !== "string" || !text)
      throw new Error("Lark message content is empty or unsupported");
    return { msgType: "text", content: JSON.stringify({ text }) };
  }
  async postMessage(threadId: string, message: AdapterPostableMessage) {
    const decoded = this.decodeThreadId(threadId);
    if (decoded.threadId) throw new Error("Lark group thread replies are not supported");
    const { msgType, content } = this.payload(message);
    const result = checked(
      await this.client.im.message.create({
        params: { receive_id_type: "chat_id" },
        data: { receive_id: decoded.chatId, msg_type: msgType, content },
      }),
    );
    const id = result.data?.message_id;
    if (!id) throw new Error("Lark did not return a message ID");
    return { id, threadId, raw: { message_id: id } };
  }
  async editMessage(threadId: string, messageId: string, message: AdapterPostableMessage) {
    const { msgType, content } = this.payload(message);
    checked(
      await this.client.im.message.update({
        path: { message_id: messageId },
        data: { msg_type: msgType, content },
      }),
    );
    return { id: messageId, threadId, raw: { message_id: messageId } };
  }
  async deleteMessage(_threadId: string, messageId: string) {
    checked(await this.client.im.message.delete({ path: { message_id: messageId } }));
  }
}

function checked<T extends { code?: number; msg?: string }>(result: T): T {
  if (result.code)
    throw new Error(`Lark API error ${result.code}: ${result.msg ?? "Request failed"}`);
  return result;
}
function equal(a: string, b: string) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
function forbidden() {
  return new Response("Forbidden", { status: 403 });
}

function inboundText(
  content: string,
  type: string,
  mentions: NonNullable<LarkMessageEvent["message"]["mentions"]>,
): { text: string; parts?: LarkTextPart[] } {
  const replaceMentions = (value: string) => {
    for (const mention of mentions) value = value.replaceAll(mention.key, `@${mention.name}`);
    return value;
  };
  const plain = (value: string) => ({ text: replaceMentions(value) });
  if (type !== "text" && type !== "post") return plain("");
  try {
    const parsed = JSON.parse(content);
    if (typeof parsed.text === "string") return plain(parsed.text);
    const posts = parsed.post ?? parsed;
    const post = Array.isArray(posts.content)
      ? posts
      : (posts.zh_cn ?? posts.en_us ?? Object.values(posts)[0]);
    if (!post || typeof post !== "object") return plain("");
    const rich = post as {
      title?: string;
      content?: { tag: string; text?: string; href?: string; user_name?: string }[][];
    };
    const itemText = (item: NonNullable<typeof rich.content>[number][number]) =>
      item.tag === "a"
        ? `[${item.text ?? ""}](${item.href ?? ""})`
        : item.tag === "at"
          ? `@${item.user_name ?? "unknown"}`
          : item.tag === "text" || item.tag === "code_block"
            ? (item.text ?? "")
            : "";
    if ((rich.content ?? []).some((row) => row.some((item) => item.tag === "code_block"))) {
      const rows: LarkTextPart[][] = (rich.content ?? []).map((row) =>
        row.map((item) => ({ text: itemText(item), literal: item.tag === "code_block" })),
      );
      const nonemptyRows = rows.filter((row) => row.some((part) => part.text));
      const groups = [
        ...(rich.title ? [[{ text: `# ${rich.title}`, literal: false }]] : []),
        ...nonemptyRows,
      ];
      const parts: LarkTextPart[] = [];
      const append = (part: LarkTextPart) => {
        if (!part.text) return;
        const last = parts.at(-1);
        if (!part.literal && last && !last.literal) last.text += part.text;
        else parts.push({ ...part });
      };
      groups.forEach((row, index) => {
        if (index) append({ text: "\n", literal: false });
        row.forEach(append);
      });
      for (const part of parts) if (!part.literal) part.text = replaceMentions(part.text);
      return { text: parts.map((part) => part.text).join(""), parts };
    }
    return plain(
      [
        rich.title ? `# ${rich.title}` : undefined,
        ...(rich.content ?? []).map((row) => row.map(itemText).join("")),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  } catch {
    return plain(content);
  }
}
export async function createLarkAdapter(config: LarkAdapterConfig) {
  const sdk = await import("@larksuiteoapi/node-sdk");
  return new LarkAdapter(config, sdk);
}
