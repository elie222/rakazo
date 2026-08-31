import type { AdapterContext, MessagingProvider } from "@rakazo/adapter-kit";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type ChatSdkAdapter,
  type ChatSdkInboundInput,
  ChatSdkMessagingProvider,
  chatSdkConfigFromEnv,
  createChatSdkAdapter,
  createMessagingProvider,
  isChatSdkEnabled,
  parseChatSdkInbound,
  registerChatSdkAdapter,
} from "./chatsdk.js";
import { ChatSdkEmulator } from "./chatsdk-emulator.js";
import { SendBlueMessagingProvider } from "./sendblue.js";

const context: AdapterContext = {
  spaceId: "ws-1",
  userId: "user-1",
  botId: "bot-1",
  runId: "run-1",
  operationId: "op-1",
  traceId: "trace-1",
  signal: new AbortController().signal,
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("parseChatSdkInbound", () => {
  it("maps a normalized DM message onto the neutral event", () => {
    expect(
      parseChatSdkInbound({
        id: "wamid-1",
        text: "hello there",
        threadId: "emulated:dm:+15551234567",
        author: { userId: "+15551234567" },
        attachments: [],
      }),
    ).toEqual({
      type: "message",
      handle: "wamid-1",
      fromNumber: "+15551234567",
      groupId: null,
      groupName: null,
      participants: [],
      content: "hello there",
      mediaUrl: null,
    });
  });

  it("passes the sender identifier through without platform-specific normalization", () => {
    const event = parseChatSdkInbound({ id: "m-1", author: { userId: "US.123456" } });
    expect(event).toEqual(
      expect.objectContaining({ type: "message", fromNumber: "US.123456", content: "" }),
    );
  });

  it("maps the first attachment URL onto mediaUrl", () => {
    const event = parseChatSdkInbound({
      id: "m-2",
      author: { userId: "u-1" },
      attachments: [{ url: "https://cdn.test/a.png" }, { url: "https://cdn.test/b.png" }],
    });
    expect(event).toEqual(expect.objectContaining({ mediaUrl: "https://cdn.test/a.png" }));
  });

  it("returns null for unusable input", () => {
    expect(parseChatSdkInbound(null)).toBeNull();
    expect(parseChatSdkInbound(undefined)).toBeNull();
    expect(parseChatSdkInbound("nope" as unknown as ChatSdkInboundInput)).toBeNull();
    expect(parseChatSdkInbound({})).toBeNull();
    expect(parseChatSdkInbound({ id: "", author: { userId: "u-1" } })).toBeNull();
    expect(parseChatSdkInbound({ id: "m-1" })).toBeNull();
    expect(parseChatSdkInbound({ id: "m-1", author: { userId: "" } })).toBeNull();
  });
});

describe("isChatSdkEnabled", () => {
  const emulator = new ChatSdkEmulator();

  it("requires the named adapter to be present in the configuration", () => {
    vi.stubEnv("VITEST", "");
    expect(isChatSdkEnabled({ adapters: { emulated: emulator }, adapterName: "emulated" })).toBe(
      true,
    );
    expect(isChatSdkEnabled({ adapters: { emulated: emulator }, adapterName: "other" })).toBe(
      false,
    );
    expect(isChatSdkEnabled({ adapters: {}, adapterName: "emulated" })).toBe(false);
    expect(isChatSdkEnabled(undefined)).toBe(false);
  });

  it("is disabled under vitest even with a full config", () => {
    expect(process.env.VITEST).toBeTruthy();
    expect(isChatSdkEnabled({ adapters: { emulated: emulator }, adapterName: "emulated" })).toBe(
      false,
    );
  });
});

describe("chat-sdk adapter registry", () => {
  it("constructs registered adapters by configuration name", () => {
    const emulator = new ChatSdkEmulator();
    registerChatSdkAdapter("registry-test", () => emulator);
    expect(createChatSdkAdapter("registry-test")).toBe(emulator);
    expect(createChatSdkAdapter("unknown")).toBeUndefined();
  });
});

describe("chatSdkConfigFromEnv", () => {
  it("returns undefined without an adapter name or a registered adapter", () => {
    expect(chatSdkConfigFromEnv({ messagingChatSdkAdapter: undefined })).toBeUndefined();
    expect(chatSdkConfigFromEnv({ messagingChatSdkAdapter: "  " })).toBeUndefined();
    expect(chatSdkConfigFromEnv({ messagingChatSdkAdapter: "never-registered" })).toBeUndefined();
  });

  it("resolves a registered adapter into the configuration", () => {
    const emulator = new ChatSdkEmulator();
    registerChatSdkAdapter("env-test", () => emulator);
    expect(chatSdkConfigFromEnv({ messagingChatSdkAdapter: "env-test" })).toEqual({
      adapters: { "env-test": emulator },
      adapterName: "env-test",
    });
  });
});

describe("ChatSdkMessagingProvider", () => {
  it("rejects construction when the configured adapter is missing", () => {
    expect(() => new ChatSdkMessagingProvider({ adapters: {}, adapterName: "emulated" })).toThrow(
      /not configured/,
    );
  });

  it("derives capabilities from the configured adapter instance", () => {
    const full = new ChatSdkMessagingProvider({
      adapters: { emulated: new ChatSdkEmulator() },
      adapterName: "emulated",
    });
    expect(full.describe().capabilities).toEqual({ direct: true, groups: false, typing: true });

    const minimalAdapter = {
      name: "minimal",
      userName: "minimal-bot",
      startTyping: undefined,
    } as unknown as ChatSdkAdapter;
    const minimal = new ChatSdkMessagingProvider({
      adapters: { minimal: minimalAdapter },
      adapterName: "minimal",
    });
    expect(minimal.describe().capabilities).toEqual({
      direct: false,
      groups: false,
      typing: false,
    });
  });

  it("describes itself with the adapter name in the id", () => {
    const provider = new ChatSdkMessagingProvider({
      adapters: { emulated: new ChatSdkEmulator() },
      adapterName: "emulated",
    });
    expect(provider.describe()).toEqual(
      expect.objectContaining({ id: "chatsdk-emulated", contractVersion: "1" }),
    );
  });

  it("throws on the unsupported group surface", async () => {
    const provider = new ChatSdkMessagingProvider({
      adapters: { emulated: new ChatSdkEmulator() },
      adapterName: "emulated",
    });
    await expect(provider.sendGroup({ groupId: "grp-1", body: "hi" }, context)).rejects.toThrow(
      /group sends/,
    );
    await expect(provider.getGroup("grp-1", context)).rejects.toThrow(/group lookups/);
  });
});

describe("createMessagingProvider", () => {
  const sendBlueConfig = {
    apiKeyId: "key-id",
    apiSecret: "secret",
    signingSecret: "signing",
    phoneNumber: "+15550009999",
  };

  it("selects SendBlue by default and preserves the phone-surface gate", () => {
    vi.stubEnv("VITEST", "");
    const provider = createMessagingProvider({
      provider: undefined,
      deploymentModelKey: "model-key",
      sendBlueConfig,
      chatSdkConfig: undefined,
    });
    expect(provider).toBeInstanceOf(SendBlueMessagingProvider);

    expect(
      createMessagingProvider({
        provider: undefined,
        deploymentModelKey: undefined,
        sendBlueConfig,
        chatSdkConfig: undefined,
      }),
    ).toBeUndefined();
  });

  it("selects chat-sdk only when an adapter is configured and the model key is present", () => {
    vi.stubEnv("VITEST", "");
    const chatSdkConfig = {
      adapters: { emulated: new ChatSdkEmulator() },
      adapterName: "emulated",
    };
    const provider = createMessagingProvider({
      provider: "chat-sdk",
      deploymentModelKey: "model-key",
      sendBlueConfig,
      chatSdkConfig,
    });
    expect(provider).toBeInstanceOf(ChatSdkMessagingProvider);

    // No adapter configured: the surface stays disabled.
    expect(
      createMessagingProvider({
        provider: "chat-sdk",
        deploymentModelKey: "model-key",
        sendBlueConfig,
        chatSdkConfig: undefined,
      }),
    ).toBeUndefined();

    // Phone-created users need the deployment model key regardless of transport.
    expect(
      createMessagingProvider({
        provider: "chat-sdk",
        deploymentModelKey: undefined,
        sendBlueConfig,
        chatSdkConfig,
      }),
    ).toBeUndefined();
  });

  it("keeps chat-sdk disabled under vitest even with full configuration", () => {
    const provider: MessagingProvider | undefined = createMessagingProvider({
      provider: "chat-sdk",
      deploymentModelKey: "model-key",
      sendBlueConfig,
      chatSdkConfig: { adapters: { emulated: new ChatSdkEmulator() }, adapterName: "emulated" },
    });
    expect(provider).toBeUndefined();
  });
});
