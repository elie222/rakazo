import { describe, expect, it, vi } from "vitest";
import { configuredEmailProvider } from "./email.js";

const smtp = { smtpUrl: "smtps://smtp.example.test", emailFrom: "hello@example.test" };

describe("configuredEmailProvider", () => {
  it("keeps email optional and existing SMTP configurations working", () => {
    expect(configuredEmailProvider({ smtpUrl: undefined, emailFrom: undefined })).toBeUndefined();
    expect(configuredEmailProvider(smtp)?.describe().id).toBe("smtp");
    expect(configuredEmailProvider({ ...smtp, emailProvider: "none" })).toBeUndefined();
  });

  it("selects the Resend API explicitly even with old SMTP settings present", () => {
    expect(
      configuredEmailProvider({
        ...smtp,
        emailProvider: "resend",
        emailApiKey: "fake-key",
      })?.describe().id,
    ).toBe("resend");
  });

  it("passes the generic account configuration to Cloudflare", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        success: true,
        result: { delivered: ["user@example.test"], queued: [], permanent_bounces: [] },
      }),
    );
    vi.stubGlobal("fetch", request);
    try {
      const email = configuredEmailProvider({
        ...smtp,
        emailProvider: "cloudflare",
        emailApiKey: "fake-key",
        emailAccountId: "0123456789abcdef0123456789abcdef",
        emailReplyTo: "reply@example.test",
      });
      await email!.send({ to: "user@example.test", subject: "Test", text: "Body" });
      expect(request.mock.calls[0]![0]).toContain("/0123456789abcdef0123456789abcdef/");
      expect(JSON.parse(request.mock.calls[0]![1]!.body as string).reply_to).toBe(
        "reply@example.test",
      );
      expect(() =>
        configuredEmailProvider({ ...smtp, emailProvider: "cloudflare", emailApiKey: "fake-key" }),
      ).toThrow("EMAIL_ACCOUNT_ID");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects unknown or incomplete configurations instead of disabling recovery silently", () => {
    expect(() => configuredEmailProvider({ ...smtp, emailProvider: "typo" })).toThrow(
      "EMAIL_PROVIDER",
    );
    expect(() => configuredEmailProvider({ ...smtp, emailProvider: "resend" })).toThrow(
      "EMAIL_API_KEY",
    );
    expect(() =>
      configuredEmailProvider({ smtpUrl: undefined, emailFrom: undefined, emailProvider: "smtp" }),
    ).toThrow("SMTP_URL");
  });
});
