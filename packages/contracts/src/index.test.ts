import { describe, expect, it } from "vitest";
import {
  appContract,
  CreateBotInput,
  CreateGroupInput,
  MessageBlock,
  ModelOAuthBeginSchema,
  ProductEventType,
  UpdateGroupInput,
} from "./index.js";

describe("contracts", () => {
  it("parses bot create input", () => {
    const parsed = CreateBotInput.parse({ name: "Chief" });
    expect(parsed.title).toBe("");
    expect(parsed.notifyOnFinish).toBe(true);
  });

  it("normalizes group names and rejects duplicate members", () => {
    expect(CreateGroupInput.parse({ name: "  Draft team  ", botIds: ["bot-1", "bot-2"] })).toEqual({
      name: "Draft team",
      botIds: ["bot-1", "bot-2"],
    });
    expect(CreateGroupInput.safeParse({ name: "   ", botIds: ["bot-1", "bot-2"] }).success).toBe(
      false,
    );
    expect(
      UpdateGroupInput.safeParse({ groupId: "group-1", botIds: ["bot-1", "bot-1"] }).success,
    ).toBe(false);
  });

  it("keeps model OAuth start results mode-specific", () => {
    const shared = {
      loginId: "login-1",
      provider: "anthropic",
      verificationUri: "https://example.com/authorize",
      expiresInSeconds: 900,
    };
    expect(ModelOAuthBeginSchema.safeParse({ ...shared, mode: "auth-url" }).success).toBe(true);
    expect(ModelOAuthBeginSchema.safeParse({ ...shared, mode: "device-code" }).success).toBe(false);
    expect(
      ModelOAuthBeginSchema.safeParse({ ...shared, mode: "device-code", userCode: "ABCD-1234" })
        .success,
    ).toBe(true);
    expect(
      ModelOAuthBeginSchema.safeParse({
        ...shared,
        mode: "auth-url",
        verificationUri: "javascript:alert(1)",
      }).success,
    ).toBe(false);
  });

  it("exposes the product rpc surface", () => {
    expect(appContract.models.beginOAuth).toBeTruthy();
    expect(appContract.bootstrap).toBeTruthy();
    expect(appContract.models.completeOAuth).toBeTruthy();
    expect(appContract.bots.create).toBeTruthy();
    expect(appContract.bots.archive).toBeTruthy();
    expect(appContract.bots.restore).toBeTruthy();
    expect(appContract.bots.remove).toBeTruthy();
    expect(appContract.botSections.list).toBeTruthy();
    expect(appContract.botSections.create).toBeTruthy();
    expect(appContract.threads.subscribe).toBeTruthy();
    expect(appContract.threads.clear).toBeTruthy();
    expect(appContract.voice.prepare).toBeTruthy();
    expect(appContract.notifications.registerPush).toBeTruthy();
    expect(ProductEventType.options).toContain("thread.message.created");
    expect(ProductEventType.options).toContain("thread.cleared");
    expect(ProductEventType.options).toContain("thread.subagent");
    expect(ProductEventType.options).toContain("bot.spawned");
  });

  it("rejects oversized chart data wherever it is embedded", () => {
    const rows = Array.from({ length: 5_001 }, (_, index) => index);

    expect(
      MessageBlock.safeParse({ kind: "chart", name: "outer", spec: {}, data: rows }).success,
    ).toBe(false);
    expect(
      MessageBlock.safeParse({
        kind: "chart",
        name: "spec",
        spec: { data: rows },
        data: [],
      }).success,
    ).toBe(false);
    expect(
      MessageBlock.safeParse({
        kind: "chart",
        name: "marks",
        spec: { marks: [{ data: rows }] },
        data: [],
      }).success,
    ).toBe(false);
    expect(
      MessageBlock.safeParse({
        kind: "chart",
        name: "combined",
        spec: { marks: [{ data: rows.slice(0, 2_500) }] },
        data: rows.slice(0, 2_501),
      }).success,
    ).toBe(false);
  });
});
