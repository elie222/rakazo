import type { ChatInstance, WebhookOptions } from "chat";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodePhotonThreadId,
  encodePhotonThreadId,
  LazyPhotonAdapter,
  PHOTON_LISTEN_WINDOW_MS,
} from "./lazy-adapter.js";

const fake = vi.hoisted(() => ({
  created: [] as Record<string, unknown>[],
  listens: [] as { durationMs: number; signal: AbortSignal; options: WebhookOptions }[],
  initialize: vi.fn(async () => undefined),
  postMessage: vi.fn(async () => ({
    id: "msg-1",
    threadId: "imessage:any;-;+15550001111",
    raw: {},
  })),
}));

vi.mock("@photon-ai/chat-adapter-imessage", () => ({
  createiMessageAdapter: (config: Record<string, unknown>) => {
    fake.created.push(config);
    return {
      userName: "imessage",
      initialize: fake.initialize,
      postMessage: fake.postMessage,
      startGatewayListener: async (
        options: WebhookOptions,
        durationMs: number,
        signal: AbortSignal,
      ) => {
        fake.listens.push({ durationMs, signal, options });
        return new Response(null, { status: 200 });
      },
    };
  },
}));

const chat = {} as ChatInstance;
const credentials = { projectId: "project", projectSecret: "secret" };

beforeEach(() => {
  vi.useFakeTimers();
  fake.created.length = 0;
  fake.listens.length = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("LazyPhotonAdapter", () => {
  it("loads Photon's adapter only when first used", async () => {
    const adapter = new LazyPhotonAdapter({ ...credentials, pollInboundMessages: false });
    expect(fake.created).toEqual([]);
    await adapter.postMessage("imessage:any;-;+15550001111", "hello");
    expect(fake.created).toEqual([credentials]);
    expect(fake.postMessage).toHaveBeenCalledWith("imessage:any;-;+15550001111", "hello");
  });

  it("consumes the inbound stream in the polling process and re-arms it", async () => {
    const adapter = new LazyPhotonAdapter({ ...credentials, pollInboundMessages: true });
    await adapter.initialize(chat);
    expect(fake.initialize).toHaveBeenCalledWith(chat);
    expect(fake.listens).toHaveLength(1);
    expect(fake.listens[0]!.durationMs).toBe(PHOTON_LISTEN_WINDOW_MS);
    await vi.advanceTimersByTimeAsync(PHOTON_LISTEN_WINDOW_MS);
    expect(fake.listens).toHaveLength(2);
    // Each window has its own signal, so abort listeners never accumulate.
    expect(fake.listens[1]!.signal).not.toBe(fake.listens[0]!.signal);

    await adapter.stopPolling();
    expect(fake.listens[1]!.signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(PHOTON_LISTEN_WINDOW_MS * 3);
    expect(fake.listens).toHaveLength(2);
  });

  it("keeps stream failures from becoming unhandled rejections", async () => {
    const adapter = new LazyPhotonAdapter({ ...credentials, pollInboundMessages: true });
    await adapter.initialize(chat);
    const failing = Promise.reject(new Error("sink down"));
    fake.listens[0]!.options.waitUntil?.(failing);
    await expect(failing).rejects.toThrow("sink down");
    await adapter.stopPolling();
  });

  it("does not stream in send-only processes or when webhooks deliver inbound", async () => {
    await new LazyPhotonAdapter({ ...credentials, pollInboundMessages: false }).initialize(chat);
    const webhook = new LazyPhotonAdapter({
      ...credentials,
      webhookSecret: "whsec",
      pollInboundMessages: true,
    });
    await webhook.initialize(chat);
    expect(fake.listens).toEqual([]);
    expect(fake.created.at(-1)).toEqual({ ...credentials, webhookSecret: "whsec" });
  });

  it("answers thread-id questions without loading the SDK", () => {
    const adapter = new LazyPhotonAdapter({ ...credentials, pollInboundMessages: false });
    expect(adapter.isDM("imessage:any;-;+15550001111")).toBe(true);
    expect(adapter.isDM("imessage:any;+;chat123~+15550002222")).toBe(false);
    expect(fake.created).toEqual([]);
  });
});

describe("Photon thread ids", () => {
  it("round-trips the chat GUID and the pinned line", () => {
    const pinned = { chatGuid: "any;-;+15550001111", phone: "+15550002222" };
    expect(encodePhotonThreadId(pinned)).toBe("imessage:any;-;+15550001111~+15550002222");
    expect(decodePhotonThreadId(encodePhotonThreadId(pinned))).toEqual(pinned);
    expect(decodePhotonThreadId("imessage:any;-;+15550001111")).toEqual({
      chatGuid: "any;-;+15550001111",
    });
  });

  it("rejects foreign or empty ids", () => {
    expect(() => decodePhotonThreadId("telegram:1")).toThrow();
    expect(() => decodePhotonThreadId("imessage:")).toThrow();
  });
});
