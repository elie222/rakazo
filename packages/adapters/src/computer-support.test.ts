import { describe, expect, it } from "vitest";
import {
  displayBotWorkspacePath,
  normalizeSandboxFilePath,
  resolveBotUploadPath,
  resolveBotWorkspaceCwd,
  resolveBotWorkspacePath,
  teamBotWorkspaceDirectory,
} from "./computer-support.js";

describe("Team Computer bot folders", () => {
  it("uses the bot folder for relative paths and cwd", () => {
    expect(teamBotWorkspaceDirectory("bot-1")).toBe("bots/bot-1");
    expect(resolveBotWorkspacePath("team", "bot-1", "notes/result.txt")).toBe(
      "bots/bot-1/notes/result.txt",
    );
    expect(resolveBotWorkspacePath("team", "bot-1", "")).toBe("bots/bot-1");
    expect(resolveBotWorkspaceCwd("team", "bot-1", undefined)).toBe("bots/bot-1");
    expect(resolveBotWorkspaceCwd("team", "bot-1", "projects/site")).toBe(
      "bots/bot-1/projects/site",
    );
    expect(resolveBotWorkspaceCwd("team", "bot-1", "/Users/me/project")).toBe("/Users/me/project");
  });

  it("preserves Windows absolute working directories even when the backend runs on Linux", () => {
    const drive = String.raw`C:\Users\example\project`;
    const share = String.raw`\\server\share\project`;
    expect(resolveBotWorkspaceCwd("team", "bot-1", drive)).toBe(drive);
    expect(resolveBotWorkspaceCwd("team", "bot-1", share)).toBe(share);
  });

  it("keeps shared, bot-root, and absolute paths at the Team root", () => {
    expect(resolveBotWorkspacePath("team", "bot-1", "shared/brief.md")).toBe("shared/brief.md");
    expect(resolveBotWorkspacePath("team", "bot-1", "bots/bot-2/result.md")).toBe(
      "bots/bot-2/result.md",
    );
    expect(resolveBotWorkspacePath("team", "bot-1", "/root-note.md")).toBe("root-note.md");
    expect(resolveBotWorkspacePath("team", "bot-1", "/shared/brief.md")).toBe("shared/brief.md");
  });

  it("treats the sandbox home prefix as the workspace root on Team Computers", () => {
    expect(resolveBotWorkspacePath("team", "bot-1", "/home/rakazo")).toBe("");
    expect(resolveBotWorkspacePath("team", "bot-1", "/home/rakazo/notes/x.md")).toBe("notes/x.md");
    expect(resolveBotWorkspacePath("team", "bot-1", "/home/rakazo/shared/brief.md")).toBe(
      "shared/brief.md",
    );
    expect(() => resolveBotWorkspacePath("team", "bot-1", "/home/rakazo/../x")).toThrow(
      "escapes the computer workspace",
    );
    // Dedicated computers keep the absolute path; the provider applies its own home mapping.
    expect(resolveBotWorkspacePath("dedicated", "bot-1", "/home/rakazo/notes/x.md")).toBe(
      "/home/rakazo/notes/x.md",
    );
  });

  it("treats hosted workspace roots as the workspace root on Team Computers", () => {
    expect(resolveBotWorkspacePath("team", "bot-1", "/home/user/rakazo-home/notes/x.md")).toBe(
      "notes/x.md",
    );
    expect(
      resolveBotWorkspacePath("team", "bot-1", "/home/desktop/rakazo-home/shared/brief.md"),
    ).toBe("shared/brief.md");
  });

  it("treats a leading ~ as the workspace root", () => {
    expect(resolveBotWorkspacePath("team", "bot-1", "~")).toBe("");
    expect(resolveBotWorkspacePath("team", "bot-1", "~/notes/x.md")).toBe("notes/x.md");
    expect(resolveBotWorkspacePath("team", "bot-1", "~\\notes\\x.md")).toBe("notes/x.md");
    expect(resolveBotWorkspacePath("team", "bot-1", "~/shared/brief.md")).toBe("shared/brief.md");
    expect(resolveBotWorkspacePath("dedicated", "bot-1", "~/notes/x.md")).toBe("/notes/x.md");
    expect(resolveBotWorkspacePath("team", "bot-1", "~x/y")).toBe("bots/bot-1/~x/y");
    expect(() => resolveBotWorkspacePath("team", "bot-1", "~/../x")).toThrow(
      "Path escapes the computer workspace",
    );
  });

  it("keeps root paths for a listing requested under ~", () => {
    expect(displayBotWorkspacePath("team", "bot-1", "~/bots", "bots/bot-1")).toBe("bots/bot-1");
  });

  it("presents the current bot folder as its home without hiding Team paths", () => {
    expect(displayBotWorkspacePath("team", "bot-1", "notes", "bots/bot-1/notes/result.txt")).toBe(
      "notes/result.txt",
    );
    expect(displayBotWorkspacePath("team", "bot-1", "shared", "shared/brief.md")).toBe(
      "shared/brief.md",
    );
    expect(displayBotWorkspacePath("team", "bot-1", "bots", "bots/bot-1")).toBe("bots/bot-1");
    expect(displayBotWorkspacePath("team", "bot-1", "/", "bots/bot-1")).toBe("bots/bot-1");
    expect(
      displayBotWorkspacePath("team", "bot-1", "bots/bot-1", "bots/bot-1/notes/result.txt"),
    ).toBe("bots/bot-1/notes/result.txt");
  });

  it("leaves Private Computer paths unchanged", () => {
    expect(resolveBotWorkspacePath("dedicated", "bot-1", "notes/result.txt")).toBe(
      "notes/result.txt",
    );
    expect(resolveBotWorkspaceCwd("dedicated", "bot-1", undefined)).toBeUndefined();
    expect(displayBotWorkspacePath("dedicated", "bot-1", "notes", "notes/result.txt")).toBe(
      "notes/result.txt",
    );
  });
});

describe("normalizeSandboxFilePath", () => {
  it("strips a matching home prefix the way the command cwd mapping does", () => {
    const roots = ["/home/user/rakazo-home", "/home/rakazo"] as const;
    expect(normalizeSandboxFilePath("/home/rakazo/notes/x.md", roots)).toBe("notes/x.md");
    expect(normalizeSandboxFilePath("/home/user/rakazo-home/notes/x.md", roots)).toBe("notes/x.md");
    expect(normalizeSandboxFilePath("/home/rakazo", roots)).toBe("");
    expect(normalizeSandboxFilePath("notes/x.md", roots)).toBe("notes/x.md");
    expect(normalizeSandboxFilePath("/notes/x.md", roots)).toBe("notes/x.md");
    // A home-looking path the roots do not cover keeps its old literal meaning.
    expect(normalizeSandboxFilePath("/home/other/notes/x.md", roots)).toBe("home/other/notes/x.md");
  });

  it("still rejects traversal under a stripped home prefix", () => {
    expect(() => normalizeSandboxFilePath("/home/rakazo/../x", ["/home/rakazo"])).toThrow(
      "escapes the computer workspace",
    );
  });
});

describe("resolveBotUploadPath", () => {
  it("keeps team uploads in the controlling bot home or shared", () => {
    expect(resolveBotUploadPath("team", "bot-1", "notes.txt")).toBe("bots/bot-1/notes.txt");
    expect(resolveBotUploadPath("team", "bot-1", "shared/brief.md")).toBe("shared/brief.md");
    expect(() => resolveBotUploadPath("team", "bot-1", "bots/bot-2/secret.txt")).toThrow(
      /escapes the bot workspace/,
    );
  });
});
