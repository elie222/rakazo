import { SandboxFileTooLargeError, SandboxProviderAccountError } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import type { RunContext } from "../assembly/run-context.js";
import type { ToolCall } from "./run-tool-gate.js";
import { fileTools } from "./run-tools-files.js";

function setup() {
  const stored = {
    id: "computer-1",
    homeKey: "home-1",
    scope: "team",
    kind: "boat",
    providerRef: "sandbox-1",
    screenGeneration: 5,
    homeRevision: "revision-1",
    homeRevisionAt: new Date(),
  };
  const findFirst = vi.fn().mockResolvedValue(stored);
  const readStoppedFile = vi.fn().mockResolvedValue(new TextEncoder().encode("saved SECRET"));
  const readFile = vi.fn().mockResolvedValue(new TextEncoder().encode("live contents"));
  const get = vi.fn().mockResolvedValue(stored);
  const controller = new AbortController();
  const ctx = {
    bot: { id: "bot-1" },
    run: { spaceId: "space-1" },
    computer: { stored, kind: stored.kind, mode: "team", lazy: {}, get },
    context: { signal: controller.signal },
    deps: { prisma: { computer: { findFirst } }, sandbox: { readStoppedFile, readFile } },
    secrets: ["SECRET"],
  } as unknown as RunContext;
  const read = (path: string) =>
    fileTools.read_file!(ctx, { name: "read_file", args: { path } } as unknown as ToolCall);
  return { read, readStoppedFile, get, findFirst, stored, controller };
}

describe("read_file with a suspended computer", () => {
  it("returns redacted text from the stopped disk without claiming the computer", async () => {
    const { read, readStoppedFile, get, findFirst, stored } = setup();
    const result = await read("notes.txt");
    expect(result).toMatchObject({ path: "notes.txt", totalLines: 1 });
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(readStoppedFile).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: stored.providerRef }),
      "bots/bot-1/notes.txt",
      expect.anything(),
      expect.objectContaining({ savedAt: stored.homeRevisionAt }),
    );
    expect(findFirst).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          state: "suspended",
          screenGeneration: stored.screenGeneration,
        }),
      }),
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("discards saved bytes if the computer changes before the read returns", async () => {
    const { read, findFirst, get, stored } = setup();
    findFirst.mockResolvedValueOnce(stored).mockResolvedValueOnce(null);
    await expect(read("notes.txt")).resolves.toMatchObject({ content: "live contents" });
    expect(get).toHaveBeenCalledOnce();
  });

  it("uses the live reader when the provider's optional snapshot read fails", async () => {
    const { read, readStoppedFile, get } = setup();
    readStoppedFile.mockRejectedValueOnce(new SandboxProviderAccountError());
    await expect(read("notes.txt")).resolves.toMatchObject({ content: "live contents" });
    expect(get).toHaveBeenCalledOnce();
  });

  it("does not wake the computer if the run is cancelled during the snapshot read", async () => {
    const { read, readStoppedFile, get, controller } = setup();
    readStoppedFile.mockImplementationOnce(async () => {
      controller.abort();
      controller.signal.throwIfAborted();
    });
    await expect(read("notes.txt")).rejects.toMatchObject({ name: "AbortError" });
    expect(get).not.toHaveBeenCalled();
  });

  it("reports a verified oversized file without waking, and retries if the computer changed", async () => {
    const { read, readStoppedFile, findFirst, get, stored } = setup();
    const tooLarge = new SandboxFileTooLargeError(250_000);
    readStoppedFile.mockRejectedValueOnce(tooLarge);
    await expect(read("notes.txt")).resolves.toMatchObject({
      error: expect.stringContaining("file is over"),
    });
    expect(get).not.toHaveBeenCalled();

    readStoppedFile.mockRejectedValueOnce(tooLarge);
    findFirst.mockResolvedValueOnce(stored).mockResolvedValueOnce(null);
    await expect(read("notes.txt")).resolves.toMatchObject({ content: "live contents" });
    expect(get).toHaveBeenCalledOnce();
  });

  it("uses the live computer to materialize attachments before reading", async () => {
    const { read, findFirst, get } = setup();
    await expect(read("attachments/upload.txt")).resolves.toMatchObject({
      content: "live contents",
    });
    expect(findFirst).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledOnce();
  });
});
