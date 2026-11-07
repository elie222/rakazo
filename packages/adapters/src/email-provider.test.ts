import { afterEach, describe, expect, it, vi } from "vitest";
import { configuredEmailProvider } from "./email-provider.js";

const config = {
  provider: "cloudflare",
  accountId: "0123456789abcdef0123456789abcdef",
  apiKey: "fake-api-key",
  from: "hello@example.test",
  replyTo: "replies@example.test",
};

afterEach(() => vi.unstubAllGlobals());

describe("configuredEmailProvider", () => {
  it("selects Cloudflare with the generic account and sender configuration", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        success: true,
        errors: [],
        messages: [],
        result: {
          message_id: "email-1",
          delivered: ["user@example.test"],
          queued: [],
          permanent_bounces: [],
          suppressed_recipients: [],
        },
      }),
    );
    vi.stubGlobal("fetch", request);
    const email = configuredEmailProvider(config);
    expect(email?.describe()).toMatchObject({
      id: "cloudflare",
      contractVersion: "1",
      capabilities: { transactional: true },
    });
    await email!.send({ to: "user@example.test", subject: "Welcome", text: "Hello" });
    await email!.drain?.();
    expect(request).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]![0]).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${config.accountId}/email/sending/send`,
    );
    expect(new Headers(request.mock.calls[0]![1]!.headers).get("authorization")).toBe(
      `Bearer ${config.apiKey}`,
    );
    expect(JSON.parse(request.mock.calls[0]![1]!.body as string)).toMatchObject({
      from: config.from,
      reply_to: config.replyTo,
    });
  });

  it.each(["accountId", "apiKey", "from"] as const)(
    "rejects missing Cloudflare %s rather than falling back to another provider",
    (field) => {
      expect(() => configuredEmailProvider({ ...config, [field]: undefined })).toThrow();
    },
  );

  it("keeps email optional and explicit none overrides an SMTP URL", () => {
    expect(configuredEmailProvider({})).toBeUndefined();
    expect(
      configuredEmailProvider({ provider: "none", smtpUrl: "smtps://smtp.example.test" }),
    ).toBeUndefined();
  });

  it.each([undefined, "smtp"])("preserves SMTP selection (%s)", async (provider) => {
    const email = configuredEmailProvider({
      provider,
      smtpUrl: "smtps://smtp.example.test",
      from: "hello@example.test",
    });
    expect(email?.describe().id).toBe("smtp");
    await email!.drain?.();
  });

  it("preserves explicit Resend selection", async () => {
    const email = configuredEmailProvider({ ...config, provider: "resend" });
    expect(email?.describe().id).toBe("resend");
    await email!.drain?.();
  });

  it("rejects an unknown selector", () => {
    expect(() => configuredEmailProvider({ ...config, provider: "unknown" })).toThrow();
  });
});
