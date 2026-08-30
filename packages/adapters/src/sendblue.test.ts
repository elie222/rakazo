import { describe, expect, it, vi } from "vitest";
import {
  isPhoneSurfaceEnabled,
  isSendBlueEnabled,
  parseSendBlueInbound,
  SendBlueMessagingProvider,
} from "./sendblue.js";

const config = {
  apiKeyId: "key-id",
  apiSecret: "secret",
  signingSecret: "signing",
  phoneNumber: "+15550009999",
};

const context = {
  workspaceId: "ws-1",
  userId: "user-1",
  botId: "bot-1",
  runId: "run-1",
  operationId: "op-1",
  traceId: "trace-1",
  signal: new AbortController().signal,
};

function providerReturning(response: Response) {
  const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) => response);
  return { provider: new SendBlueMessagingProvider(config, { fetch: fetchMock }), fetchMock };
}

describe("SendBlueMessagingProvider", () => {
  it("describes itself as a messaging provider", () => {
    const { provider } = providerReturning(Response.json({}));
    expect(provider.describe()).toEqual({
      id: "sendblue",
      contractVersion: "1",
      adapterVersion: "0.1.0",
      capabilities: { direct: true, groups: true, typing: true },
    });
  });

  it("posts a typing indicator with auth headers", async () => {
    const { provider, fetchMock } = providerReturning(Response.json({ status: "SENT" }));
    await provider.sendTypingIndicator({ to: "+15551234567" }, context);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.sendblue.com/api/send-typing-indicator");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("sb-api-key-id")).toBe("key-id");
    expect(headers.get("sb-api-secret-key")).toBe("secret");
    expect(JSON.parse(String(init?.body))).toEqual({
      number: "+15551234567",
      from_number: "+15550009999",
    });
  });

  it("throws on a non-2xx typing response so the caller's catch is meaningful", async () => {
    const { provider } = providerReturning(
      Response.json({ status: "ERROR", message: "no chat" }, { status: 422 }),
    );
    await expect(provider.sendTypingIndicator({ to: "+15551234567" }, context)).rejects.toThrow(
      /send-typing-indicator.*422/,
    );
  });

  it("sends a direct message with auth headers and returns the handle", async () => {
    const { provider, fetchMock } = providerReturning(
      Response.json({ message_handle: "handle-1" }),
    );
    const result = await provider.sendDirect({ to: "+15551234567", body: "hello" }, context);

    expect(result).toEqual({ handle: "handle-1" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.sendblue.com/api/send-message");
    expect(init?.method).toBe("POST");
    const headers = new Headers(init?.headers);
    expect(headers.get("sb-api-key-id")).toBe("key-id");
    expect(headers.get("sb-api-secret-key")).toBe("secret");
    expect(JSON.parse(String(init?.body))).toEqual({
      number: "+15551234567",
      from_number: "+15550009999",
      content: "hello",
    });
  });

  it("sends a group message to an existing group only", async () => {
    const { provider, fetchMock } = providerReturning(
      Response.json({ message_handle: "handle-2" }),
    );
    const result = await provider.sendGroup({ groupId: "group-9", body: "hi all" }, context);

    expect(result).toEqual({ handle: "handle-2" });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.sendblue.com/api/send-group-message");
    expect(JSON.parse(String(init?.body))).toEqual({
      group_id: "group-9",
      from_number: "+15550009999",
      content: "hi all",
    });
  });

  it("reads group participants from the nested vendor envelope", async () => {
    const { provider, fetchMock } = providerReturning(
      Response.json({
        data: {
          group_id: "group-9",
          group_name: "Family",
          participant_numbers: ["+15551111111", "+15552222222"],
        },
      }),
    );
    const group = await provider.getGroup("group-9", context);

    expect(group).toEqual({
      id: "group-9",
      name: "Family",
      participants: ["+15551111111", "+15552222222"],
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.sendblue.com/api/v2/groups/group-9");
    expect(init?.method ?? "GET").toBe("GET");
  });

  it("still accepts a flat group fixture for older emulator shapes", async () => {
    const { provider } = providerReturning(
      Response.json({
        group_id: "group-flat",
        group_display_name: "Flat",
        participants: ["+15551111111"],
      }),
    );
    await expect(provider.getGroup("group-flat", context)).resolves.toEqual({
      id: "group-flat",
      name: "Flat",
      participants: ["+15551111111"],
    });
  });

  it("throws on non-2xx responses", async () => {
    const { provider } = providerReturning(
      new Response(JSON.stringify({ status: "ERROR", message: "Unauthorized" }), {
        status: 401,
      }),
    );
    await expect(provider.sendDirect({ to: "+15551234567", body: "x" }, context)).rejects.toThrow(
      /401/,
    );
  });

  it("URL-encodes group ids and threads the abort signal", async () => {
    const { provider, fetchMock } = providerReturning(
      Response.json({ group_id: "g/1", participants: [] }),
    );
    await provider.getGroup("g/1", context);

    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.sendblue.com/api/v2/groups/g%2F1");
    expect(init?.signal).toBe(context.signal);
  });
});

describe("isSendBlueEnabled", () => {
  it("requires all four env values", () => {
    vi.stubEnv("VITEST", "");
    expect(isSendBlueEnabled(config)).toBe(true);
    expect(isSendBlueEnabled({ ...config, apiKeyId: "" })).toBe(false);
    expect(isSendBlueEnabled({ ...config, apiSecret: "" })).toBe(false);
    expect(isSendBlueEnabled({ ...config, signingSecret: "" })).toBe(false);
    expect(isSendBlueEnabled({ ...config, phoneNumber: "" })).toBe(false);
    vi.unstubAllEnvs();
  });

  it("is disabled under vitest even with full config", () => {
    expect(process.env.VITEST).toBeTruthy();
    expect(isSendBlueEnabled(config)).toBe(false);
  });
});

describe("parseSendBlueInbound", () => {
  const receivePayload = {
    content: "Hello!",
    is_outbound: false,
    status: "RECEIVED",
    message_handle: "99DCC379-DD76-4712-BA65-11EFB33B8CD6",
    from_number: "+19998887777",
    sendblue_number: "+15122164639",
    media_url: "",
    group_id: "",
    participants: ["+19998887777", "+15122164639"],
    group_display_name: null,
  };

  it("normalizes a 1:1 receive event", () => {
    expect(parseSendBlueInbound(receivePayload)).toEqual({
      type: "message",
      handle: "99DCC379-DD76-4712-BA65-11EFB33B8CD6",
      fromNumber: "+19998887777",
      groupId: null,
      groupName: null,
      participants: ["+19998887777", "+15122164639"],
      content: "Hello!",
      mediaUrl: null,
    });
  });

  it("normalizes a group receive event", () => {
    expect(
      parseSendBlueInbound({
        ...receivePayload,
        group_id: "grp-1",
        group_display_name: "Family",
        media_url: "https://cdn.example.com/pic.jpg",
      }),
    ).toEqual({
      type: "message",
      handle: "99DCC379-DD76-4712-BA65-11EFB33B8CD6",
      fromNumber: "+19998887777",
      groupId: "grp-1",
      groupName: "Family",
      participants: ["+19998887777", "+15122164639"],
      content: "Hello!",
      mediaUrl: "https://cdn.example.com/pic.jpg",
    });
  });

  it("normalizes an outbound status event", () => {
    expect(
      parseSendBlueInbound({ ...receivePayload, is_outbound: true, status: "DELIVERED" }),
    ).toEqual({
      type: "status",
      handle: "99DCC379-DD76-4712-BA65-11EFB33B8CD6",
      status: "DELIVERED",
    });
  });

  it("treats a missing is_outbound flag as inbound when from_number is present", () => {
    const { is_outbound: _dropped, ...withoutFlag } = receivePayload;
    const parsed = parseSendBlueInbound(withoutFlag);
    expect(parsed).toMatchObject({ type: "message", fromNumber: "+19998887777" });
  });

  it("ignores non-message events and malformed payloads", () => {
    expect(parseSendBlueInbound({ event_type: "call_log", call_id: "cs_1" })).toBeNull();
    expect(parseSendBlueInbound(null)).toBeNull();
    expect(parseSendBlueInbound("nope")).toBeNull();
    expect(parseSendBlueInbound({ is_outbound: false })).toBeNull();
  });
});

describe("isPhoneSurfaceEnabled", () => {
  it("requires SendBlue config and a deployment model key", () => {
    vi.stubEnv("VITEST", "");
    expect(isPhoneSurfaceEnabled(config, "model-key")).toBe(true);
    expect(isPhoneSurfaceEnabled(config, undefined)).toBe(false);
    expect(isPhoneSurfaceEnabled({ ...config, apiSecret: "" }, "model-key")).toBe(false);
    vi.unstubAllEnvs();
  });
});

describe("SendBlueMessagingProvider base URL policy", () => {
  it("rejects a non-HTTPS base URL before any authenticated request", () => {
    // The API secret rides every request header; a cleartext base URL would
    // expose it on the wire.
    expect(
      () => new SendBlueMessagingProvider({ ...config, baseUrl: "http://sendblue.example" }),
    ).toThrow(/https/i);
    expect(
      () => new SendBlueMessagingProvider({ ...config, baseUrl: "https://sendblue.example" }),
    ).not.toThrow();
    expect(() => new SendBlueMessagingProvider(config)).not.toThrow();
  });
});

describe("SendBlueMessagingProvider redirect policy", () => {
  it("sends every credential-bearing request with redirect: error", async () => {
    // Without an explicit redirect mode, fetch follows cross-origin
    // redirects and forwards the sb-api-* headers to the new origin.
    // Fresh body per call: a shared Response is consumed after one read.
    const fetchMock = vi.fn(async (_input: unknown, _init?: RequestInit) =>
      Response.json({ message_handle: "h-1" }),
    );
    const provider = new SendBlueMessagingProvider(config, { fetch: fetchMock });
    await provider.sendDirect({ to: "+15551234567", body: "hi" }, context);
    await provider.sendGroup({ groupId: "group-9", body: "hi all" }, context);
    await provider.sendTypingIndicator({ to: "+15551234567" }, context);
    await provider.getGroup("group-9", context);

    expect(fetchMock).toHaveBeenCalledTimes(4);
    for (const [, init] of fetchMock.mock.calls) {
      expect(init).toEqual(expect.objectContaining({ redirect: "error" }));
    }
  });
});
