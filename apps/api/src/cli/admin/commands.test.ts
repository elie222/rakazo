import { describe, expect, it } from "vitest";
import { ADMIN_USAGE, formatAdminResult, parseAdminArgs } from "./commands.js";

describe("parseAdminArgs", () => {
  it("reads the webhook key command with its flags in any position", () => {
    expect(parseAdminArgs(["bot", "webhook-key", "bot_1"])).toMatchObject({ json: false });
    expect(parseAdminArgs(["--json", "bot", "webhook-key", "bot_1", "--rotate"])).toMatchObject({
      json: true,
    });
  });

  it.each([
    [[]],
    [["bot"]],
    [["bot", "webhook-key"]],
    [["bot", "webhook-key", "bot_1", "extra"]],
    [["bot", "webhook-key", "bot 1"]],
    [["bot", "webhook-key", "bot_1", "--force"]],
    [["bot", "webhook-key", "bot_1", "--rotate=yes"]],
    [["bots", "webhook-key", "bot_1"]],
  ])("refuses %j", (argv) => {
    expect(parseAdminArgs(argv)).toBeNull();
  });

  it("lists every command in the usage text", () => {
    expect(ADMIN_USAGE).toContain("bot webhook-key <bot-id> [--rotate]");
  });
});

describe("formatAdminResult", () => {
  const result = {
    text: "https://app.example.test/api/v1/bots/bot_1/webhook\nkey",
    json: { botId: "bot_1", url: "https://app.example.test/api/v1/bots/bot_1/webhook", key: "key" },
  };

  it("prints text for a person and one JSON line for a program", () => {
    expect(formatAdminResult(result, false)).toBe(`${result.text}\n`);
    expect(JSON.parse(formatAdminResult(result, true))).toEqual(result.json);
    expect(formatAdminResult(result, true).trim().split("\n")).toHaveLength(1);
  });
});
