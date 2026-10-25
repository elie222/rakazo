import type * as LarkSdk from "@larksuiteoapi/node-sdk";
import { describe, expect, it, vi } from "vitest";
import { LarkAdapter } from "./lark-adapter.js";
import type { LarkAdapterConfig } from "./lazy-adapter.js";
import { encodeThreadId } from "./thread-id.js";

const config: LarkAdapterConfig = {
  appId: "cli_test",
  appSecret: "test-secret",
  verificationToken: "test-token",
  encryptKey: "test-encrypt-key",
  domain: "https://open.larksuite.com",
};

function fakeSdk() {
  const create = vi.fn(async () => ({ code: 0, data: { message_id: "om_1" } }));
  const update = vi.fn(async () => ({ code: 0, data: {} }));
  class Client {
    im = { message: { create, update } };
  }
  const sdk = { Client, LoggerLevel: { error: 4 } };
  return { sdk: sdk as unknown as typeof LarkSdk, create, update };
}

const threadId = encodeThreadId({ chatId: "oc_123" });

describe("LarkAdapter payloads", () => {
  it("posts Markdown as a rich-text md block instead of raw text", async () => {
    const { sdk, create } = fakeSdk();
    const adapter = new LarkAdapter(config, sdk);

    await adapter.postMessage(threadId, { markdown: "## Plan\n\n**Bold** step" });

    expect(create).toHaveBeenCalledExactlyOnceWith({
      params: { receive_id_type: "chat_id" },
      data: {
        receive_id: "oc_123",
        msg_type: "post",
        content: JSON.stringify({
          zh_cn: { content: [[{ tag: "md", text: "## Plan\n\n**Bold** step" }]] },
        }),
      },
    });
  });

  it("keeps plain strings as text", async () => {
    const { sdk, create } = fakeSdk();
    const adapter = new LarkAdapter(config, sdk);

    await adapter.postMessage(threadId, "hello");

    expect(create).toHaveBeenCalledExactlyOnceWith({
      params: { receive_id_type: "chat_id" },
      data: { receive_id: "oc_123", msg_type: "text", content: JSON.stringify({ text: "hello" }) },
    });
  });

  it("edits a message with the same markdown payload", async () => {
    const { sdk, update } = fakeSdk();
    const adapter = new LarkAdapter(config, sdk);

    await adapter.editMessage(threadId, "om_1", { markdown: "*updated*" });

    expect(update).toHaveBeenCalledExactlyOnceWith({
      path: { message_id: "om_1" },
      data: {
        msg_type: "post",
        content: JSON.stringify({ zh_cn: { content: [[{ tag: "md", text: "*updated*" }]] } }),
      },
    });
  });

  it("rejects an empty postable", async () => {
    const { sdk } = fakeSdk();
    const adapter = new LarkAdapter(config, sdk);

    await expect(adapter.postMessage(threadId, { raw: "" })).rejects.toThrow(
      /empty or unsupported/,
    );
  });
});
