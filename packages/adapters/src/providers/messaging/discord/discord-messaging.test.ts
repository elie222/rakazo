import { createMemoryState } from "@chat-adapter/state-memory";
import type { MessagingInboundMessage } from "@rakazo/adapter-kit";
import { deferred } from "@rakazo/core/test-async";
import type { ChatInstance, WebhookOptions } from "chat";
import { Chat, Message, parseMarkdown } from "chat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  messagingEnvFromProcess,
  messagingPlatformsFromEnv,
  splitOutboundBody,
} from "../../../messaging/messaging-platforms.js";
import {
  DISCORD_MARKDOWN_LIMIT,
  discordIsPermanentSendError,
  discordPayloads,
  enrichDiscordTeamRoom,
} from "./discord-messaging.js";
import {
  DISCORD_CHANNEL_NAME_RETRY_MS,
  DISCORD_GATEWAY_RETRY_DELAYS_MS,
  DISCORD_LISTEN_WINDOW_MS,
  DISCORD_START_RETRY_DELAYS_MS,
  LazyDiscordAdapter,
} from "./lazy-adapter.js";

const publicKey = "0123456789abcdef".repeat(4);
const env = {
  DISCORD_BOT_TOKEN: " bot-token ",
  DISCORD_PUBLIC_KEY: ` ${publicKey} `,
  DISCORD_APPLICATION_ID: " app-id ",
  DISCORD_MENTION_ROLE_IDS: " role-1, role-2 ",
};

const fake = vi.hoisted(() => ({
  created: [] as Record<string, unknown>[],
  listens: [] as { durationMs: number; signal: AbortSignal; options: WebhookOptions }[],
  // Statuses the next Gateway starts answer with; 200 once the queue is empty.
  startStatuses: [] as number[],
  // Gates a start holds open, so a failure can land after its replacement began.
  startGates: [] as Promise<void>[],
  chat: undefined as ChatInstance | undefined,
  initialize: vi.fn(async (chat: ChatInstance) => {
    fake.chat = chat;
  }),
  postMessage: vi.fn(async () => ({ id: "msg-1", raw: {} })),
  fetchChannelInfo: vi.fn(async () => ({ name: "launch" })),
}));

vi.mock("@chat-adapter/discord", () => ({
  createDiscordAdapter: (config: Record<string, unknown>) => {
    fake.created.push(config);
    return {
      userName: "discord-bot",
      initialize: fake.initialize,
      postMessage: fake.postMessage,
      fetchChannelInfo: fake.fetchChannelInfo,
      startGatewayListener: async (
        options: WebhookOptions,
        durationMs: number,
        signal: AbortSignal,
      ) => {
        fake.listens.push({ durationMs, signal, options });
        // The status and the gate belong to this call, whichever start settles first.
        const status = fake.startStatuses.shift() ?? 200;
        const gate = fake.startGates.shift();
        if (gate) await gate;
        return new Response(null, { status });
      },
    };
  },
}));

const config = {
  botToken: "bot-token",
  publicKey,
  applicationId: "app-id",
  mentionRoleIds: ["role-1", "role-2"],
  // Discord invites carry only the public application id, so a guild is served only
  // when the operator named it.
  allowedGuildIds: ["G1"],
  pollInboundMessages: false,
};

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  fake.created.length = 0;
  fake.listens.length = 0;
  fake.startStatuses.length = 0;
  fake.startGates.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Discord credentials", () => {
  it("mounts with all three required variables, trimmed, and parses mention roles", () => {
    const values = messagingEnvFromProcess(env);
    expect(values).toMatchObject({
      discordBotToken: "bot-token",
      discordPublicKey: publicKey,
      discordApplicationId: "app-id",
      discordMentionRoleIds: "role-1, role-2",
    });
    const [platform, ...rest] = messagingPlatformsFromEnv(values);
    expect(rest).toEqual([]);
    expect(platform?.provider).toBe("discord");
    expect((platform!.adapter as LazyDiscordAdapter).config).toMatchObject({
      botToken: "bot-token",
      publicKey,
      applicationId: "app-id",
      mentionRoleIds: ["role-1", "role-2"],
    });
  });

  it("stays off when any required variable is missing", () => {
    for (const name of [
      "DISCORD_BOT_TOKEN",
      "DISCORD_PUBLIC_KEY",
      "DISCORD_APPLICATION_ID",
    ] as const) {
      expect(
        messagingPlatformsFromEnv(messagingEnvFromProcess({ ...env, [name]: " " })).map(
          (platform) => platform.provider,
        ),
      ).toEqual([]);
    }
  });

  it("omits blank mention roles and only streams in the polling process", () => {
    const from = (roles: string, pollInboundMessages?: boolean) =>
      (
        messagingPlatformsFromEnv(
          messagingEnvFromProcess({ ...env, DISCORD_MENTION_ROLE_IDS: roles }),
          {
            pollInboundMessages,
          },
        )[0]!.adapter as LazyDiscordAdapter
      ).config;
    expect(from(" , ")).not.toHaveProperty("mentionRoleIds");
    expect(from("role-1, role-2").pollInboundMessages).toBe(false);
    expect(from("role-1, role-2", true).pollInboundMessages).toBe(true);
  });
});

const base: MessagingInboundMessage = {
  type: "message",
  provider: "discord",
  handle: "m1",
  threadId: "discord:G1:C1",
  isDirect: false,
  from: "U1",
  fromLabel: "Ada",
  channelName: "launch",
  participants: [],
  content: "hi",
  mediaUrl: null,
};

const guildMessage = { guild_id: "G1", channel_id: "C1", author: { id: "U1" } };

describe("enrichDiscordTeamRoom", () => {
  it("makes a guild channel one conversation, whichever thread the message sits in", () => {
    expect(enrichDiscordTeamRoom(guildMessage, { ...base, mentionsBot: true })).toEqual({
      workspaceId: "G1",
      conversationKey: "discord:G1:C1",
      kind: "mention",
      replyThreadId: null,
    });
    // Discord files a mention in a thread of its own: same conversation, threaded reply.
    expect(
      enrichDiscordTeamRoom(guildMessage, {
        ...base,
        threadId: "discord:G1:C1:T1",
        mentionsBot: true,
      }),
    ).toEqual({
      workspaceId: "G1",
      conversationKey: "discord:G1:C1",
      kind: "mention",
      replyThreadId: "T1",
    });
    expect(enrichDiscordTeamRoom(guildMessage, base)).toMatchObject({ kind: "ambient" });
  });

  it("waits for the room's Ambient setting when another bot speaks", () => {
    expect(
      enrichDiscordTeamRoom(
        { ...guildMessage, author: { id: "B2", bot: true } },
        {
          ...base,
          mentionsBot: true,
        },
      ),
    ).toMatchObject({ senderIsBot: true, kind: "ambient" });
  });

  it("reads a forwarded event envelope", () => {
    expect(
      enrichDiscordTeamRoom(
        { type: "GATEWAY_MESSAGE_CREATE", timestamp: 1, data: guildMessage },
        base,
      ),
    ).toMatchObject({ workspaceId: "G1", conversationKey: "discord:G1:C1", replyThreadId: null });
  });

  it("leaves direct messages alone and flags bot senders", () => {
    const dm: MessagingInboundMessage = {
      ...base,
      threadId: "discord:@me:D1",
      isDirect: true,
    };
    expect(enrichDiscordTeamRoom({ guild_id: "@me", channel_id: "D1", author: {} }, dm)).toEqual(
      {},
    );
    expect(
      enrichDiscordTeamRoom({ guild_id: "@me", channel_id: "D1", author: { bot: true } }, dm),
    ).toEqual({ senderIsBot: true });
    expect(enrichDiscordTeamRoom({ ...guildMessage, author: { bot: true } }, base)).toMatchObject({
      senderIsBot: true,
    });
  });

  it("takes the room from the thread id even when the raw payload says little", () => {
    for (const raw of [{}, { guild_id: "G1" }, { channel_id: "C1", author: { id: "U1" } }]) {
      expect(enrichDiscordTeamRoom(raw, base)).toEqual({
        workspaceId: "G1",
        conversationKey: "discord:G1:C1",
        kind: "ambient",
        replyThreadId: null,
      });
    }
    // No payload at all is no message at all.
    for (const raw of [null, "nope", 7]) {
      expect(enrichDiscordTeamRoom(raw, base)).toEqual({});
    }
  });

  it("ignores thread ids it did not mint", () => {
    expect(enrichDiscordTeamRoom(guildMessage, { ...base, threadId: "telegram:1" })).toEqual({});
    expect(enrichDiscordTeamRoom(guildMessage, { ...base, threadId: "discord:@me" })).toEqual({});
  });
});

describe("discord channel naming", () => {
  const platformFrom = () =>
    messagingPlatformsFromEnv(messagingEnvFromProcess(env), { pollInboundMessages: false })[0]!;

  it("never names a guild channel by its id, and never names a DM", () => {
    const platform = platformFrom();
    // Before the name is read, the conversation carries none: an id is not a name.
    expect(platform.enrichTeamRoom?.(guildMessage, base)).not.toHaveProperty("channelName");
    // Inside a thread, the conversation is still the channel it hangs off.
    expect(
      platform.enrichTeamRoom?.({}, { ...base, threadId: "discord:G1:C1:T1" }),
    ).not.toHaveProperty("channelName");
    expect(
      platform.enrichTeamRoom?.({}, { ...base, threadId: "discord:@me:D1", isDirect: true }),
    ).not.toHaveProperty("channelName");
  });

  it("learns the channel's name once and lists the conversation by it", async () => {
    const platform = platformFrom();
    const adapter = platform.adapter as LazyDiscordAdapter;

    await adapter.postMessage("discord:G1:C1", { markdown: "hi" });
    // The lookup runs alongside the send; let the promise chain settle.
    await vi.advanceTimersByTimeAsync(0);
    expect(adapter.channelNameForThread("discord:G1:C1")).toBe("launch");

    expect(fake.fetchChannelInfo).toHaveBeenCalledOnce();
    expect(platform.enrichTeamRoom?.(guildMessage, base)).toMatchObject({ channelName: "launch" });

    // A second message in the same channel, thread or not, asks Discord nothing more.
    await adapter.postMessage("discord:G1:C1:T1", { markdown: "hi" });
    expect(fake.fetchChannelInfo).toHaveBeenCalledOnce();
  });
});

const settle = () => vi.advanceTimersByTimeAsync(0);

describe("discord channel naming under failure", () => {
  it("asks again later when the lookup fails instead of treating the channel as nameless", async () => {
    const adapter = new LazyDiscordAdapter({ ...config, allowedGuildIds: ["G1"] });
    fake.fetchChannelInfo.mockRejectedValueOnce(new Error("discord 503"));
    await adapter.postMessage("discord:G1:C1", { markdown: "hi" });
    await settle();
    expect(adapter.channelNameForThread("discord:G1:C1")).toBeNull();

    // The error said nothing about the channel, so a later message asks again.
    await vi.advanceTimersByTimeAsync(DISCORD_CHANNEL_NAME_RETRY_MS);
    await adapter.postMessage("discord:G1:C1", { markdown: "hi" });
    await settle();
    expect(adapter.channelNameForThread("discord:G1:C1")).toBe("launch");
  });

  it("stops asking once Discord answers without a name", async () => {
    const adapter = new LazyDiscordAdapter({ ...config, allowedGuildIds: ["G1"] });
    fake.fetchChannelInfo.mockResolvedValueOnce({});
    await adapter.postMessage("discord:G1:C1", { markdown: "hi" });
    await settle();
    const calls = fake.fetchChannelInfo.mock.calls.length;
    await adapter.postMessage("discord:G1:C1", { markdown: "hi" });
    await settle();
    expect(fake.fetchChannelInfo.mock.calls.length).toBe(calls);
    expect(adapter.channelNameForThread("discord:G1:C1")).toBeNull();
  });

  it("makes the second concurrent message wait for the lookup in flight", async () => {
    const adapter = new LazyDiscordAdapter({ ...config, allowedGuildIds: ["G1"] });
    const lookup = deferred<{ name: string }>();
    fake.fetchChannelInfo.mockImplementation(() => lookup.promise);
    const first = adapter.postMessage("discord:G1:C1", { markdown: "one" });
    const second = adapter.postMessage("discord:G1:C1", { markdown: "two" });
    await settle();
    lookup.resolve({ name: "launch" });
    await Promise.all([first, second]);
    await settle();
    expect(fake.fetchChannelInfo).toHaveBeenCalledTimes(1);
    expect(adapter.channelNameForThread("discord:G1:C1")).toBe("launch");
  });
});

describe("discord outbound", () => {
  it("measures the text the adapter sends, resolving emoji placeholders", () => {
    expect(discordPayloads("plain")).toEqual(["plain"]);
    expect(discordPayloads("{{emoji:thumbs_up}}")).toEqual(["👍"]);
  });

  it("reserves the longest user id a bare mention becomes on the wire", () => {
    const [measured] = discordPayloads("ping @Ada");
    expect(measured).toBe("ping <@Ada00000000000000000>");
    expect(measured!.length).toBeGreaterThan("ping <@Ada>".length);
  });

  it("splits long replies into parts under Discord's limit", () => {
    const long = "a".repeat(5_000);
    const parts = splitOutboundBody("discord", long);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.every((part) => discordPayloads(part)[0]!.length <= DISCORD_MARKDOWN_LIMIT)).toBe(
      true,
    );
    expect(splitOutboundBody("discord", `${"a".repeat(1_500)}\n\n${"b".repeat(1_500)}`)).toEqual([
      "a".repeat(1_500),
      "b".repeat(1_500),
    ]);
    expect(splitOutboundBody("discord", "short")).toEqual(["short"]);
  });
});

describe("discordIsPermanentSendError", () => {
  /** The shape the Chat SDK throws: a NetworkError wrapping Discord's own API error. */
  const apiError = (code: number, message: string, status = 403) =>
    Object.assign(new Error(`Discord API error: ${status} ${message}`), {
      code: "NETWORK_ERROR",
      originalError: Object.assign(new Error(message), { code, status }),
    });

  it("recognizes unreachable channels, roles, members and denied access", () => {
    expect(discordIsPermanentSendError(apiError(10003, "Unknown Channel"))).toBe(true);
    expect(discordIsPermanentSendError(apiError(10011, "Unknown Role"))).toBe(true);
    expect(discordIsPermanentSendError(apiError(50007, "Cannot send messages to this user"))).toBe(
      true,
    );
    expect(discordIsPermanentSendError(apiError(50013, "Missing Permissions"))).toBe(true);
    expect(discordIsPermanentSendError(new Error("Missing Permissions"))).toBe(true);
    expect(discordIsPermanentSendError({ code: "PERMISSION_DENIED" })).toBe(true);
  });

  it("leaves transient failures retryable", () => {
    expect(discordIsPermanentSendError(new Error("fetch failed"))).toBe(false);
    expect(discordIsPermanentSendError(apiError(50_000, "Internal Server Error", 500))).toBe(false);
    expect(discordIsPermanentSendError(apiError(0, "You are being rate limited", 429))).toBe(false);
  });
});

describe("LazyDiscordAdapter", () => {
  it("loads the vendor adapter only on first use", async () => {
    const adapter = new LazyDiscordAdapter(config);
    expect(fake.created).toEqual([]);
    await adapter.postMessage("discord:@me:C1", "hello");
    expect(fake.created).toEqual([
      {
        botToken: config.botToken,
        publicKey: config.publicKey,
        applicationId: config.applicationId,
        // The bot's user name is its application id: no literal `@bot` in a channel can
        // read as a mention of it.
        userName: config.applicationId,
        mentionRoleIds: config.mentionRoleIds,
        logger: expect.any(Object),
      },
    ]);
    expect(fake.postMessage).toHaveBeenCalledWith("discord:@me:C1", "hello");
  });

  it("re-arms the Gateway listener in polling mode, closing the window it replaces", async () => {
    const adapter = new LazyDiscordAdapter({ ...config, pollInboundMessages: true });
    await adapter.initialize({} as ChatInstance);
    expect(fake.listens).toHaveLength(1);
    expect(fake.listens[0]!.durationMs).toBe(DISCORD_LISTEN_WINDOW_MS);
    await vi.advanceTimersByTimeAsync(DISCORD_LISTEN_WINDOW_MS);
    expect(fake.listens).toHaveLength(2);
    expect(fake.listens[1]!.signal).not.toBe(fake.listens[0]!.signal);
    // The replaced listener is aborted, so two Gateway clients never overlap.
    expect(fake.listens[0]!.signal.aborted).toBe(true);
    expect(fake.listens[1]!.signal.aborted).toBe(false);
    await adapter.stopPolling();
    expect(fake.listens[1]!.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(DISCORD_LISTEN_WINDOW_MS * 3);
    expect(fake.listens).toHaveLength(2);
  });

  it("retries a Gateway start that fails, well inside the listening window", async () => {
    fake.startStatuses.push(502, 503);
    const adapter = new LazyDiscordAdapter({ ...config, pollInboundMessages: true });
    await adapter.initialize({} as ChatInstance);
    await vi.advanceTimersByTimeAsync(0);
    expect(fake.listens).toHaveLength(1);

    // The first retry comes seconds after the failure, not at the next window.
    await vi.advanceTimersByTimeAsync(DISCORD_START_RETRY_DELAYS_MS[0]!);
    expect(fake.listens).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(DISCORD_START_RETRY_DELAYS_MS[1]!);
    expect(fake.listens).toHaveLength(3);
    // The third start succeeds, so nothing retries again.
    await vi.advanceTimersByTimeAsync(DISCORD_START_RETRY_DELAYS_MS[2]!);
    expect(fake.listens).toHaveLength(3);
    await adapter.stopPolling();
  });

  it("stops retrying a failed start once polling stops", async () => {
    fake.startStatuses.push(502, 502, 502);
    const adapter = new LazyDiscordAdapter({ ...config, pollInboundMessages: true });
    await adapter.initialize({} as ChatInstance);
    await vi.advanceTimersByTimeAsync(0);
    await adapter.stopPolling();
    await vi.advanceTimersByTimeAsync(DISCORD_START_RETRY_DELAYS_MS[0]! * 4);
    expect(fake.listens).toHaveLength(1);
  });

  it("reads a channel's name before delivering the message that named it", async () => {
    const adapter = new LazyDiscordAdapter({ ...config, pollInboundMessages: true });
    const chat = new Chat({
      userName: "rakazo",
      adapters: { discord: adapter },
      state: createMemoryState(),
      concurrency: "concurrent",
    });
    const handler = vi.fn(async () => undefined);
    chat.onNewMessage(/(?:)/, handler);
    await chat.initialize();
    const threadId = "discord:G1:C1";
    const message = new Message({
      id: "msg-named",
      threadId,
      text: "hello channel",
      formatted: parseMarkdown("hello channel"),
      author: { userId: "U1", userName: "Ada", fullName: "Ada", isBot: false, isMe: false },
      metadata: { dateSent: new Date(), edited: false },
      attachments: [],
      raw: {},
    });

    await fake.chat!.handleIncomingMessage(adapter, threadId, message);
    // The conversation is stored under the channel's name, so the lookup ran first.
    expect(fake.fetchChannelInfo.mock.invocationCallOrder[0]).toBeLessThan(
      handler.mock.invocationCallOrder[0]!,
    );
    expect(adapter.channelNameForThread(threadId)).toBe("launch");
    await adapter.stopPolling();
  });

  const gatewayMessage = (threadId: string) =>
    new Message({
      id: `msg-${threadId}`,
      threadId,
      text: "hello",
      formatted: parseMarkdown("hello"),
      author: { userId: "U1", userName: "Ada", fullName: "Ada", isBot: false, isMe: false },
      metadata: { dateSent: new Date(), edited: false },
      attachments: [],
      raw: {},
    });

  it("answers in an allowed guild and drops a guild it was not told to serve", async () => {
    const adapter = new LazyDiscordAdapter({ ...config, pollInboundMessages: true });
    const chat = new Chat({
      userName: "rakazo",
      adapters: { discord: adapter },
      state: createMemoryState(),
      concurrency: "concurrent",
    });
    const handler = vi.fn(async () => undefined);
    chat.onNewMessage(/(?:)/, handler);
    await chat.initialize();

    await fake.chat!.handleIncomingMessage(
      adapter,
      "discord:G1:C1",
      gatewayMessage("discord:G1:C1"),
    );
    expect(handler).toHaveBeenCalledTimes(1);

    // A stranger's server: the bot can be invited by anyone, so only a named guild runs.
    await fake.chat!.handleIncomingMessage(
      adapter,
      "discord:G9:C9",
      gatewayMessage("discord:G9:C9"),
    );
    expect(handler).toHaveBeenCalledTimes(1);

    const dmHandler = vi.fn(async () => undefined);
    chat.onDirectMessage(dmHandler);
    // A direct message is nobody's guild and is always served.
    await fake.chat!.handleIncomingMessage(
      adapter,
      "discord:@me:D1",
      gatewayMessage("discord:@me:D1"),
    );
    expect(dmHandler).toHaveBeenCalledTimes(1);
    await adapter.stopPolling();
  });

  it("serves no guild at all when the allowlist is empty, and says so once", async () => {
    const adapter = new LazyDiscordAdapter({
      ...config,
      allowedGuildIds: undefined,
      pollInboundMessages: true,
    });
    const chat = new Chat({
      userName: "rakazo",
      adapters: { discord: adapter },
      state: createMemoryState(),
      concurrency: "concurrent",
    });
    const handler = vi.fn(async () => undefined);
    chat.onNewMessage(/(?:)/, handler);
    await chat.initialize();

    for (const id of ["m1", "m2"]) {
      await fake.chat!.handleIncomingMessage(adapter, "discord:G1:C1", gatewayMessage(id));
    }
    expect(handler).not.toHaveBeenCalled();
    await adapter.stopPolling();
  });

  it("never lets a superseded start failure tear down the healthy listener", async () => {
    const gate = deferred();
    fake.startGates.push(gate.promise);
    // The first start fails, but only after the re-arm has replaced it.
    fake.startStatuses.push(500, 200);
    const adapter = new LazyDiscordAdapter({ ...config, pollInboundMessages: true });
    const chat = new Chat({
      userName: "rakazo",
      adapters: { discord: adapter },
      state: createMemoryState(),
      concurrency: "concurrent",
    });
    await chat.initialize();
    expect(fake.listens).toHaveLength(1);

    // The five-minute re-arm opens a healthy window while the first start is still open.
    await vi.advanceTimersByTimeAsync(DISCORD_LISTEN_WINDOW_MS);
    expect(fake.listens).toHaveLength(2);
    const healthy = fake.listens[1]!;

    gate.resolve();
    await vi.advanceTimersByTimeAsync(0);
    // The failed start belongs to the window it was given, so it does not retry over
    // the replacement: no third start, and the healthy window is left running.
    await vi.advanceTimersByTimeAsync(DISCORD_START_RETRY_DELAYS_MS[0]! * 2);
    expect(fake.listens).toHaveLength(2);
    expect(healthy.signal.aborted).toBe(false);
    await adapter.stopPolling();
    expect(healthy.signal.aborted).toBe(true);
  });

  it("retries a Gateway delivery whose processing fails, then gives up", async () => {
    const adapter = new LazyDiscordAdapter({ ...config, pollInboundMessages: true });
    const chat = new Chat({
      userName: "rakazo",
      adapters: { discord: adapter },
      state: createMemoryState(),
      concurrency: "concurrent",
    });
    const handler = vi.fn(async () => {
      throw new Error("sink down");
    });
    chat.onDirectMessage(handler);
    await chat.initialize();
    const threadId = "discord:@me:D1";
    const message = new Message({
      id: "msg-gateway",
      threadId,
      text: "hello",
      formatted: parseMarkdown("hello"),
      author: { userId: "U1", userName: "", fullName: "", isBot: false, isMe: false },
      metadata: { dateSent: new Date(), edited: false },
      attachments: [],
      raw: {},
    });
    // The vendor adapter reports the failure to the Chat instance we hand it, which
    // is the surface's own: the retry has to happen on that path.
    await expect(fake.chat!.handleIncomingMessage(adapter, threadId, message)).rejects.toThrow(
      "sink down",
    );
    expect(handler).toHaveBeenCalledTimes(1);
    for (const delay of DISCORD_GATEWAY_RETRY_DELAYS_MS) await vi.advanceTimersByTimeAsync(delay);
    expect(handler).toHaveBeenCalledTimes(1 + DISCORD_GATEWAY_RETRY_DELAYS_MS.length);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(handler).toHaveBeenCalledTimes(1 + DISCORD_GATEWAY_RETRY_DELAYS_MS.length);
    await adapter.stopPolling();
  });

  it("encodes thread ids without loading the SDK and stops safely before use", async () => {
    const adapter = new LazyDiscordAdapter(config);
    expect(adapter.encodeThreadId({ guildId: "G1", channelId: "C1", threadId: "T1" })).toBe(
      "discord:G1:C1:T1",
    );
    expect(adapter.decodeThreadId("discord:@me:D1")).toEqual({
      guildId: "@me",
      channelId: "D1",
    });
    expect(adapter.isDM("discord:@me:D1")).toBe(true);
    expect(adapter.isDM("discord:G1:C1")).toBe(false);
    expect(adapter.channelIdFromThreadId("discord:G1:C1:T1")).toBe("discord:G1:C1");
    expect(() => adapter.decodeThreadId("telegram:1")).toThrow();
    await expect(adapter.stopPolling()).resolves.toBeUndefined();
    expect(fake.created).toEqual([]);
  });
});
