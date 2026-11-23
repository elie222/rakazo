import type { AiConsentStatus, AiRecipient } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { aiDataSharingPlaceholder, aiPrivacyLinks, groupAiRecipients } from "./ai-data-sharing";

const model: AiRecipient = {
  key: "model",
  name: "Example AI",
  use: "model",
  detail: "example/model",
  privacyUrl: "https://example.com/privacy",
  allowed: false,
};

describe("AI data sharing sections", () => {
  it("stops loading on failure and keeps empty loaded status available", () => {
    expect(aiDataSharingPlaceholder(null, false)).toBe("loading");
    expect(aiDataSharingPlaceholder(null, true)).toBe("failed");
    const status: AiConsentStatus = {
      scope: "mobile",
      version: "2026-09-14",
      recipients: [],
    };
    expect(aiDataSharingPlaceholder(status, false)).toBe("empty");
    expect(aiDataSharingPlaceholder(status, true)).toBe("empty");
    expect(aiDataSharingPlaceholder({ ...status, recipients: [model] }, false)).toBeNull();
  });

  it("groups recipients in model, voice, memory order without changing consent state", () => {
    const voice: AiRecipient = { ...model, key: "voice", use: "voice", allowed: true };
    const memory: AiRecipient = { ...model, key: "memory", use: "memory" };
    expect(groupAiRecipients([memory, voice, model])).toEqual([
      { use: "model", recipients: [model] },
      { use: "voice", recipients: [voice] },
      { use: "memory", recipients: [memory] },
    ]);
    expect(groupAiRecipients([voice])).toEqual([{ use: "voice", recipients: [voice] }]);
    expect(groupAiRecipients([])).toEqual([]);
  });

  it("lists each provider policy once across models and uses, omitting missing policies", () => {
    expect(
      aiPrivacyLinks([
        model,
        { ...model, key: "other-model", detail: "example/other" },
        { ...model, key: "voice", use: "voice" },
        { ...model, key: "other-provider", name: "Other AI" },
        { ...model, key: "custom", privacyUrl: undefined },
      ]),
    ).toEqual([
      { name: model.name, url: model.privacyUrl },
      { name: "Other AI", url: model.privacyUrl },
    ]);
    expect(aiPrivacyLinks([])).toEqual([]);
  });
});
