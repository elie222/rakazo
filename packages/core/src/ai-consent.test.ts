import type { AiConsentStatus } from "@rakazo/contracts";
import { AI_DISCLOSURE_VERSION } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import { AiConsentBlocked, aiDataUsesForProcedure, ensureAiDataConsent } from "./ai-consent.js";

const status: AiConsentStatus = {
  scope: "account-space",
  version: AI_DISCLOSURE_VERSION,
  recipients: [
    {
      key: "model",
      name: "Example AI",
      use: "model",
      detail: "",
      privacyUrl: "https://example.com/privacy",
      allowed: false,
    },
    {
      key: "voice",
      name: "Example Voice",
      use: "voice",
      detail: "",
      privacyUrl: "https://example.com/privacy",
      allowed: false,
    },
  ],
};

describe("foreground AI consent", () => {
  it("identifies a failed preflight separately from a dispatched mutation failure", async () => {
    const check = ensureAiDataConsent({
      uses: ["model"],
      status: async () => {
        throw new Error("Offline");
      },
      prompt: vi.fn(),
      allow: vi.fn(),
    });
    await expect(check).rejects.toBeInstanceOf(AiConsentBlocked);
  });
  it("does not grant anything when declined", async () => {
    const allow = vi.fn();
    await expect(
      ensureAiDataConsent({
        uses: ["model"],
        status: async () => status,
        prompt: async () => false,
        allow,
      }),
    ).rejects.toThrow();
    expect(allow).not.toHaveBeenCalled();
  });
  it("only grants the disclosed feature after explicit permission, bound to the account and version", async () => {
    const order: string[] = [];
    const allow = vi.fn(async () => {
      order.push("allow");
    });
    await ensureAiDataConsent({
      uses: ["model"],
      status: async () => status,
      prompt: async () => {
        order.push("prompt");
        return true;
      },
      allow,
    });
    expect(order).toEqual(["prompt", "allow"]);
    expect(allow).toHaveBeenCalledExactlyOnceWith({
      scope: status.scope,
      version: status.version,
      keys: ["model"],
    });
  });
  it("does not prompt for already granted permissions or read-only procedures", async () => {
    const prompt = vi.fn();
    await ensureAiDataConsent({
      uses: ["model"],
      status: async () => ({
        ...status,
        recipients: status.recipients.map((item) => ({ ...item, allowed: true })),
      }),
      prompt,
      allow: vi.fn(),
    });
    expect(prompt).not.toHaveBeenCalled();
    expect(aiDataUsesForProcedure("threads/get")).toEqual([]);
    expect(aiDataUsesForProcedure("threads/send")).toEqual(["model", "memory"]);
    expect(aiDataUsesForProcedure("voice/prepare")).toEqual(["voice"]);
    expect(
      aiDataUsesForProcedure("routines/update", { routineId: "routine", active: false }),
    ).toEqual([]);
    expect(
      aiDataUsesForProcedure("routines/update", { routineId: "routine", active: true }),
    ).toEqual(["model", "memory"]);
  });
});
