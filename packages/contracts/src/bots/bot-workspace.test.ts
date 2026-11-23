import { describe, expect, it } from "vitest";
import { UpdateBotInput } from "./bot.js";
import { BOT_WORKSPACE_PATH_MAX_LENGTH, normalizeBotWorkspacePath } from "./bot-workspace.js";

describe("normalizeBotWorkspacePath", () => {
  it("normalizes separators, dots and repeated slashes", () => {
    expect(normalizeBotWorkspacePath("projects/website")).toBe("projects/website");
    expect(normalizeBotWorkspacePath("projects\\website")).toBe("projects/website");
    expect(normalizeBotWorkspacePath(" ./projects//./website/ ")).toBe("projects/website");
    expect(normalizeBotWorkspacePath("我的 项目/site")).toBe("我的 项目/site");
  });

  it("rejects empty and overlong values", () => {
    expect(normalizeBotWorkspacePath("")).toBeNull();
    expect(normalizeBotWorkspacePath("   ")).toBeNull();
    expect(normalizeBotWorkspacePath("/")).toBeNull();
    expect(normalizeBotWorkspacePath(`${"a/".repeat(100)}b`)).toBeNull();
    expect(normalizeBotWorkspacePath(`a/${"b".repeat(BOT_WORKSPACE_PATH_MAX_LENGTH)}`)).toBeNull();
  });

  it("rejects absolute paths and home aliases", () => {
    expect(normalizeBotWorkspacePath("/home/rakazo/projects")).toBeNull();
    expect(normalizeBotWorkspacePath("~/projects")).toBeNull();
    expect(normalizeBotWorkspacePath("\\projects")).toBeNull();
    expect(normalizeBotWorkspacePath("C:\\projects")).toBeNull();
    expect(normalizeBotWorkspacePath("c:/projects")).toBeNull();
  });

  it("rejects any '..' segment", () => {
    expect(normalizeBotWorkspacePath("../secrets")).toBeNull();
    expect(normalizeBotWorkspacePath("projects/../secrets")).toBeNull();
    expect(normalizeBotWorkspacePath("projects/..")).toBeNull();
    expect(normalizeBotWorkspacePath("projects/.../x")).toBe("projects/.../x");
  });

  it("rejects the per-bot folder root", () => {
    expect(normalizeBotWorkspacePath("bots")).toBeNull();
    expect(normalizeBotWorkspacePath("bots/bot-2")).toBeNull();
    expect(normalizeBotWorkspacePath("projects/bots")).toBe("projects/bots");
  });
});

describe("UpdateBotInput workspacePath", () => {
  const botId = `c${"a".repeat(24)}`;

  it("stores the normalized form, clears on null, and refuses escapes", () => {
    expect(UpdateBotInput.parse({ botId, workspacePath: " projects\\site/ " }).workspacePath).toBe(
      "projects/site",
    );
    expect(UpdateBotInput.parse({ botId, workspacePath: null }).workspacePath).toBeNull();
    expect(UpdateBotInput.parse({ botId }).workspacePath).toBeUndefined();
    expect(UpdateBotInput.safeParse({ botId, workspacePath: "../x" }).success).toBe(false);
    expect(UpdateBotInput.safeParse({ botId, workspacePath: "/abs" }).success).toBe(false);
  });
});
