import type {
  TeamChatInboundMessage,
  TeamChatProvider,
  TeamChatSendRequest,
  TeamChatSendResult,
} from "@rakazo/adapter-kit";
import { WebSocket } from "undici";

const SLACK_API_BASE = "https://slack.com/api";
const DEFAULT_MAX_MESSAGE_CHARS = 39_000;

export interface SlackTeamChatConfig {
  appToken: string;
  botToken: string;
}

type Fetch = typeof fetch;
type Socket = InstanceType<typeof WebSocket>;

interface SlackTeamChatDependencies {
  fetch?: Fetch;
  createSocket?: (url: string) => Socket;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  maxMessageChars?: number;
}

export function slackTeamChatConfigFromEnv(
  source: Record<string, string | undefined> = process.env,
): SlackTeamChatConfig | null {
  const appToken = source.SLACK_APP_TOKEN?.trim();
  const botToken = source.SLACK_BOT_TOKEN?.trim();
  if (!appToken && !botToken) return null;
  if (!appToken) throw new Error("SLACK_APP_TOKEN is required when Slack is enabled");
  if (!botToken) throw new Error("SLACK_BOT_TOKEN is required when Slack is enabled");
  return { appToken, botToken };
}

export function splitSlackMessage(content: string, maxChars = DEFAULT_MAX_MESSAGE_CHARS): string[] {
  const text = content.trim() || "Done.";
  const chunks: string[] = [];
  for (let offset = 0; offset < text.length; offset += maxChars) {
    chunks.push(text.slice(offset, offset + maxChars));
  }
  return chunks;
}

export function slackConversationMemberIds(channel: Record<string, unknown>): string[] {
  if (channel.is_mpim !== true || !Array.isArray(channel.members)) return [];
  return channel.members
    .map(stringValue)
    .filter((memberId): memberId is string => Boolean(memberId));
}

export async function slackConversationMetadata(
  channel: Record<string, unknown>,
  resolveUserName: (userId: string) => Promise<string>,
): Promise<{ displayName?: string; participantNames: string[] }> {
  const memberIds = slackConversationMemberIds(channel);
  const participantNames = await Promise.all(memberIds.map(resolveUserName));
  const displayName =
    channel.is_mpim === true ? participantNames.join(", ") || undefined : stringValue(channel.name);
  return { ...(displayName ? { displayName } : {}), participantNames };
}

export function parseSlackSocketEnvelope(
  value: unknown,
  botUserId: string,
  ownBotId?: string,
): { envelopeId?: string; message?: TeamChatInboundMessage } {
  if (!isRecord(value)) return {};
  const envelopeId = stringValue(value.envelope_id);
  if (value.type !== "events_api" || !isRecord(value.payload)) return { envelopeId };
  const payload = value.payload;
  if (!isRecord(payload.event)) return { envelopeId };
  const event = payload.event;
  const eventType = stringValue(event.type);
  const conversationType = slackConversationType(event.channel_type);
  const direct = eventType === "message" && event.channel_type === "im";
  const mentioned = eventType === "app_mention";
  const ambient =
    eventType === "message" &&
    (event.channel_type === "channel" ||
      event.channel_type === "group" ||
      event.channel_type === "mpim");
  const botId = stringValue(event.bot_id);
  const senderIsBot = Boolean(botId);
  const senderId = stringValue(event.user) ?? botId;
  const conversationId = stringValue(event.channel);
  const subtype = stringValue(event.subtype);
  let content = stringValue(event.text)?.trim();
  if (
    (!direct && !mentioned && !ambient) ||
    !senderId ||
    !conversationId ||
    !content ||
    (subtype && !(senderIsBot && subtype === "bot_message")) ||
    senderId === botUserId ||
    (Boolean(ownBotId) && botId === ownBotId)
  ) {
    return { envelopeId };
  }
  if (ambient && content.includes(`<@${botUserId}>`)) return { envelopeId };
  if (mentioned) {
    content = content.replace(new RegExp(`<@${escapeRegExp(botUserId)}>`, "g"), "").trim();
    if (!content) return { envelopeId };
  }
  const eventId = stringValue(payload.event_id) ?? envelopeId;
  const workspaceId = stringValue(payload.team_id);
  const eventTimestamp = stringValue(event.ts);
  if (!eventId || !workspaceId || !eventTimestamp) return { envelopeId };
  const rootThreadId = stringValue(event.thread_ts) ?? eventTimestamp;
  return {
    envelopeId,
    message: {
      eventId,
      workspaceId,
      kind: direct ? "direct" : mentioned ? "mention" : "ambient",
      ...(conversationType ? { conversationType } : {}),
      conversationKey: direct ? `dm:${conversationId}` : `channel:${conversationId}`,
      conversationId,
      replyThreadId: direct ? (stringValue(event.thread_ts) ?? null) : rootThreadId,
      senderId,
      senderName: senderIsBot ? slackBotName(event) : senderId,
      ...(senderIsBot ? { senderIsBot: true } : {}),
      content,
    },
  };
}

export class SlackTeamChatProvider implements TeamChatProvider {
  readonly id = "slack";
  private readonly fetch: Fetch;
  private readonly createSocket: (url: string) => Socket;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly maxMessageChars: number;
  private socket: Socket | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private reconnectAttempt = 0;
  private stopped = true;
  private botUserId = "";
  private botId = "";
  private handle: ((message: TeamChatInboundMessage) => Promise<void>) | undefined;
  private readonly userNames = new Map<string, string>();
  private readonly conversationMetadata = new Map<
    string,
    { displayName?: string; participantNames: string[] }
  >();

  constructor(
    private readonly config: SlackTeamChatConfig,
    dependencies: SlackTeamChatDependencies = {},
  ) {
    this.fetch = dependencies.fetch ?? fetch;
    this.createSocket = dependencies.createSocket ?? ((url) => new WebSocket(url));
    this.reconnectBaseMs = dependencies.reconnectBaseMs ?? 500;
    this.reconnectMaxMs = dependencies.reconnectMaxMs ?? 15_000;
    this.maxMessageChars = dependencies.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS;
  }

  async start(handle: (message: TeamChatInboundMessage) => Promise<void>): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    this.handle = handle;
    const auth = await this.call("auth.test", this.config.botToken);
    this.botUserId = requiredSlackString(auth, "user_id", "auth.test");
    this.botId = stringValue(auth.bot_id) ?? "";
    await this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.close(1000, "shutdown");
    this.socket = undefined;
  }

  async send(request: TeamChatSendRequest): Promise<TeamChatSendResult> {
    let handle = "";
    for (const text of splitSlackMessage(request.content, this.maxMessageChars)) {
      const response = await this.call("chat.postMessage", this.config.botToken, {
        channel: request.conversationId,
        text,
        ...(request.replyThreadId ? { thread_ts: request.replyThreadId } : {}),
      });
      handle = requiredSlackString(response, "ts", "chat.postMessage");
    }
    return { handle };
  }

  private async connect(): Promise<void> {
    const response = await this.call("apps.connections.open", this.config.appToken);
    const url = requiredSlackString(response, "url", "apps.connections.open");
    await new Promise<void>((resolve, reject) => {
      const socket = this.createSocket(url);
      this.socket = socket;
      let opened = false;
      socket.addEventListener("open", () => {
        opened = true;
        this.reconnectAttempt = 0;
        resolve();
      });
      socket.addEventListener("message", (event) => this.receive(event.data));
      socket.addEventListener("error", () => {
        if (!opened) reject(new Error("Slack Socket Mode connection failed"));
      });
      socket.addEventListener("close", () => {
        if (!opened) reject(new Error("Slack Socket Mode connection closed before opening"));
        if (this.socket === socket) this.socket = undefined;
        this.scheduleReconnect();
      });
    });
  }

  private receive(data: unknown): void {
    let value: unknown;
    try {
      value = JSON.parse(
        typeof data === "string" ? data : Buffer.from(data as ArrayBuffer).toString(),
      );
    } catch {
      return;
    }
    const parsed = parseSlackSocketEnvelope(value, this.botUserId, this.botId);
    if (parsed.envelopeId && this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ envelope_id: parsed.envelopeId }));
    }
    if (!parsed.message || !this.handle) return;
    void this.dispatch(parsed.message).catch((error) => {
      console.error("Slack inbound message error", safeError(error));
    });
  }

  private async dispatch(message: TeamChatInboundMessage): Promise<void> {
    const [senderName, metadata] = await Promise.all([
      message.senderIsBot
        ? Promise.resolve(message.senderName)
        : this.resolveUserName(message.senderId),
      message.kind === "direct"
        ? Promise.resolve(undefined)
        : this.resolveConversationMetadata(message.conversationId, message.conversationType),
    ]);
    const resolvedMetadata = metadata ?? {
      displayName: senderName,
      participantNames: [senderName],
    };
    await this.handle?.({
      ...message,
      senderName,
      ...(resolvedMetadata.displayName ? { conversationName: resolvedMetadata.displayName } : {}),
      ...(resolvedMetadata.participantNames.length > 0
        ? { participantNames: resolvedMetadata.participantNames }
        : {}),
    });
  }

  private async resolveConversationMetadata(
    conversationId: string,
    conversationType?: TeamChatInboundMessage["conversationType"],
  ): Promise<{ displayName?: string; participantNames: string[] }> {
    const cached = this.conversationMetadata.get(conversationId);
    if (cached) return cached;
    try {
      const response = await this.call("conversations.info", this.config.botToken, {
        channel: conversationId,
      });
      let channel = isRecord(response.channel) ? response.channel : undefined;
      if (!channel) return { participantNames: [] };
      if (conversationType === "mpim" && slackConversationMemberIds(channel).length === 0) {
        const membersResponse = await this.call("conversations.members", this.config.botToken, {
          channel: conversationId,
        });
        channel = {
          ...channel,
          is_mpim: true,
          members: Array.isArray(membersResponse.members) ? membersResponse.members : [],
        };
      }
      const metadata = await slackConversationMetadata(channel, (memberId) =>
        this.resolveUserName(memberId),
      );
      this.conversationMetadata.set(conversationId, metadata);
      return metadata;
    } catch {
      return { participantNames: [] };
    }
  }

  private async resolveUserName(userId: string): Promise<string> {
    const cached = this.userNames.get(userId);
    if (cached) return cached;
    try {
      const response = await this.call("users.info", this.config.botToken, {
        user: userId,
      });
      const user = isRecord(response.user) ? response.user : undefined;
      const profile = user && isRecord(user.profile) ? user.profile : undefined;
      const name =
        (profile && stringValue(profile.display_name)) ||
        (profile && stringValue(profile.real_name)) ||
        (user && stringValue(user.real_name)) ||
        userId;
      this.userNames.set(userId, name);
      return name;
    } catch {
      return "Slack member";
    }
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** this.reconnectAttempt);
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect().catch((error) => {
        console.error("Slack Socket Mode reconnect error", safeError(error));
        this.scheduleReconnect();
      });
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private async call(
    method: string,
    token: string,
    body?: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const response = await this.fetch(`${SLACK_API_BASE}/${method}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { "content-type": "application/x-www-form-urlencoded" } : {}),
      },
      body: body ? formBody(body) : undefined,
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Slack ${method} returned HTTP ${response.status}`);
    const payload: unknown = await response.json();
    if (!isRecord(payload) || payload.ok !== true) {
      const code = isRecord(payload) ? stringValue(payload.error) : undefined;
      throw new Error(`Slack ${method} failed${code ? `: ${code}` : ""}`);
    }
    return payload;
  }
}

function formBody(values: Record<string, unknown>): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) body.set(key, String(value));
  }
  return body.toString();
}

function slackConversationType(
  value: unknown,
): TeamChatInboundMessage["conversationType"] | undefined {
  return value === "im" || value === "channel" || value === "group" || value === "mpim"
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

function slackBotName(event: Record<string, unknown>): string {
  const profile = isRecord(event.bot_profile) ? event.bot_profile : undefined;
  return (
    (profile && stringValue(profile.name)) ||
    stringValue(event.username) ||
    stringValue(event.bot_id) ||
    "Slack app"
  );
}

function requiredSlackString(value: Record<string, unknown>, key: string, method: string): string {
  const result = stringValue(value[key]);
  if (!result) throw new Error(`Slack ${method} response did not include ${key}`);
  return result;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function safeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
