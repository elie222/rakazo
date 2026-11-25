import type { IngressProvider } from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import { webhooksCheck } from "./webhooks-commands.js";

const provider = (published: boolean): IngressProvider => ({
  publicOrigin: "https://hooks.example.test",
  describe: () => ({ id: "manual", label: "Your own tunnel", canUnpublish: false }),
  publish: async () => {},
  unpublish: async () => {},
  status: async () => (published ? { published: true } : { published: false, reason: "down" }),
});
const signal = new AbortController().signal;
const answering =
  (webhook: number, other: number): typeof fetch =>
  async (input) =>
    new Response(null, { status: String(input).includes("/webhook") ? webhook : other });

describe("webhooksCheck", () => {
  it("passes when a webhook reaches the app and anything else is refused", async () => {
    const result = await webhooksCheck(provider(true), signal, answering(401, 404));
    expect(result.text).toBe(
      [
        "https://hooks.example.test",
        "Provider: manual, published",
        "Webhook route: reaches this instance",
        "Other paths: refused",
      ].join("\n"),
    );
  });

  it("fails when the address exposes more than the inbound routes", async () => {
    await expect(webhooksCheck(provider(true), signal, answering(401, 200))).rejects.toThrow(
      "Other paths: not refused (200)",
    );
  });

  it("fails when nothing answers", async () => {
    const down: typeof fetch = async () => {
      throw new Error("getaddrinfo ENOTFOUND");
    };
    await expect(webhooksCheck(provider(false), signal, down)).rejects.toThrow(
      "not published (down)",
    );
  });
});
