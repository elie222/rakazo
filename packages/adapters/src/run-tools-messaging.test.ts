import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RunContext } from "./run-context.js";
import type { ToolCall } from "./run-tool-gate.js";

const mocks = vi.hoisted(() => ({
  messageBot: vi.fn(async (..._args: unknown[]) => ({
    ok: true as const,
    botId: "bot-servo",
    name: "Servo",
    note: "Sent",
  })),
  handoffToGroupBot: vi.fn(async (..._args: unknown[]) => ({ ok: true as const })),
  storeWorkspaceFile: vi.fn(async (..._args: unknown[]) => ({
    artifactId: "artifact-zip",
    block: {
      kind: "file" as const,
      artifactId: "artifact-zip",
      name: "site.zip",
      mimeType: "application/zip",
      size: 19_000,
    },
  })),
}));
vi.mock("./bot-messages.js", () => ({ messageBot: mocks.messageBot }));
vi.mock("./group-handoff.js", () => ({ handoffToGroupBot: mocks.handoffToGroupBot }));
vi.mock("./run-tools-files.js", () => ({ storeWorkspaceFile: mocks.storeWorkspaceFile }));

const { messagingTools } = await import("./run-tools-messaging.js");

function callWith(name: string, args: Record<string, unknown>) {
  return {
    name,
    args: { bot_id: "bot-servo", message: "deploy this", ...args },
    executionId: "exec-1",
    effectKey: "effect-1",
    finish: async (result: unknown) => result,
  } as unknown as ToolCall;
}

function context(servoComputerId: string) {
  const listFiles = vi.fn(async (_computer: unknown, path: string) =>
    path === "bots/bot-coder" ? [{ path: "bots/bot-coder/site", kind: "directory" }] : [],
  );
  const findMany = vi.fn(async (..._args: unknown[]) => [
    { id: "bot-coder", name: "Coder", computerId: "computer-team", computerSwitching: false },
    { id: "bot-servo", name: "Servo", computerId: servoComputerId, computerSwitching: false },
  ]);
  const ctx = {
    deps: { prisma: { bot: { findMany } }, sandbox: { listFiles } },
    run: { id: "run-1", spaceId: "space-1", userId: "user-1", threadId: "thread-1" },
    bot: { id: "bot-coder", name: "Coder", computerId: "computer-team", computerSwitching: false },
    thread: { id: "thread-1", groupId: "group-1" },
    computer: { mode: "team", get: vi.fn(async () => ({ id: "computer-team" })) },
    context: {},
    secrets: [],
    state: {},
  } as unknown as RunContext;
  return { ctx, listFiles, findMany };
}

describe("sending files to another bot", () => {
  beforeEach(() => vi.clearAllMocks());

  it("refuses more files than one message can carry before reading any", async () => {
    const { ctx, listFiles } = context("computer-team");
    await expect(
      messagingTools.message_bot!(
        ctx,
        callWith("message_bot", { files: ["a", "b", "c", "d", "e"] }),
      ),
    ).resolves.toEqual({ error: "send at most 4 files; zip the rest into one file" });
    expect(listFiles).not.toHaveBeenCalled();
    expect(mocks.messageBot).not.toHaveBeenCalled();
  });

  it("refuses a files value that is not a list of paths", async () => {
    const { ctx } = context("computer-team");
    for (const files of ["site.zip", [""], [3]]) {
      await expect(
        messagingTools.message_bot!(ctx, callWith("message_bot", { files })),
      ).resolves.toEqual({ error: "files must be a list of file paths" });
    }
    expect(mocks.messageBot).not.toHaveBeenCalled();
  });

  it("passes paths on a shared computer instead of copying them", async () => {
    const { ctx } = context("computer-team");
    await messagingTools.message_bot!(ctx, callWith("message_bot", { files: ["site"] }));
    expect(mocks.storeWorkspaceFile).not.toHaveBeenCalled();
    expect(mocks.messageBot).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        message: "deploy this\n\nFiles on our shared computer:\n- bots/bot-coder/site",
        files: [],
      }),
    );
  });

  it("hands off shared paths to a member of the group", async () => {
    const { ctx, findMany } = context("computer-team");
    await messagingTools.handoff_to_bot!(ctx, callWith("handoff_to_bot", { files: ["site"] }));
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ groupMembers: { some: { groupId: "group-1" } } }),
      }),
    );
    expect(mocks.handoffToGroupBot).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      "group-1",
      expect.objectContaining({
        message: "deploy this\n\nFiles on our shared computer:\n- bots/bot-coder/site",
        files: [],
      }),
    );
  });

  it("refuses a shared path that does not exist", async () => {
    const { ctx } = context("computer-team");
    await expect(
      messagingTools.message_bot!(ctx, callWith("message_bot", { files: ["missing"] })),
    ).resolves.toEqual({ error: "missing: not found. Nothing was sent." });
    expect(mocks.messageBot).not.toHaveBeenCalled();
  });

  it("copies files for a bot with its own computer", async () => {
    const { ctx, listFiles } = context("computer-servo");
    await messagingTools.message_bot!(ctx, callWith("message_bot", { files: ["site.zip"] }));
    expect(listFiles).not.toHaveBeenCalled();
    expect(mocks.storeWorkspaceFile).toHaveBeenCalledWith(ctx, expect.anything(), "site.zip");
    expect(mocks.messageBot).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        message: "deploy this",
        files: [expect.objectContaining({ artifactId: "artifact-zip" })],
      }),
    );
  });

  it("asks for a zip when a copy cannot be made of a folder", async () => {
    const { ctx } = context("computer-servo");
    mocks.storeWorkspaceFile.mockResolvedValueOnce({
      error: "file not found or unreadable",
    } as never);
    await expect(
      messagingTools.message_bot!(ctx, callWith("message_bot", { files: ["site"] })),
    ).resolves.toEqual({
      error: "site: file not found or unreadable; zip it and send the zip. Nothing was sent.",
    });
    expect(mocks.messageBot).not.toHaveBeenCalled();
  });
});
