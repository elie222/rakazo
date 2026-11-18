import type {
  AdapterContext,
  ArtifactStore,
  ComputerRef,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { MessageBlock } from "@rakazo/contracts";
import { ATTACHMENT_MAX_COUNT } from "@rakazo/contracts";
import { attachmentComputerPathFor } from "@rakazo/core";
import type { PrismaClient } from "@rakazo/db";
import { createLogger, createTestSink, getLogger, installLogger } from "@rakazo/logging";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import {
  attachWorkspaceFileToThread,
  createEarlierFileQueue,
  listCurrentTurnFiles,
  listRecentThreadFiles,
  materializeCurrentTurnFiles,
  materializeEarlierFiles,
  materializeRecentThreadFiles,
} from "./thread-artifacts.js";
import {
  currentTurnFilesInstruction,
  recentThreadFilesInstruction,
} from "./thread-artifacts.prompt.js";

describe("current-turn thread files", () => {
  it.each([
    ["reports\\draft.pdf", undefined, "draft.pdf"],
    ["reports/nested\\draft.pdf", undefined, "draft.pdf"],
    ["reports\\nested/draft.pdf", undefined, "draft.pdf"],
    ["reports/draft.pdf", undefined, "draft.pdf"],
    ["draft.pdf", undefined, "draft.pdf"],
    ["reports\\draft.pdf", "  ", "draft.pdf"],
    ["reports\\draft.pdf", "  Custom report.pdf  ", "Custom report.pdf"],
  ])("names attachment %s with override %s as %s", async (filePath, name, expectedName) => {
    const artifact = {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }) => ({ id: "artifact", ...data })),
    };
    const tx = { artifact, $queryRaw: vi.fn().mockResolvedValue([]) };
    const put = vi.fn().mockResolvedValue({ id: "stored" });
    const result = await attachWorkspaceFileToThread(
      {
        prisma: {
          artifact,
          $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
        } as unknown as PrismaClient,
        artifacts: { put } as unknown as ArtifactStore,
      },
      {
        spaceId: "space",
        userId: "owner",
        botId: "bot",
        runId: "run",
        filePath,
        name,
        bytes: new Uint8Array([1, 2, 3]),
        operationId: "op",
      },
    );
    expect(put).toHaveBeenCalledWith(
      expect.objectContaining({ name: expectedName, mimeType: "application/pdf" }),
      expect.anything(),
    );
    expect(artifact.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ name: { equals: expectedName, mode: "insensitive" } }),
      }),
    );
    expect(artifact.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ name: expectedName }) }),
    );
    expect(result.block).toMatchObject({ name: expectedName, mimeType: "application/pdf" });
  });
  it("signals the Space's artifacts after a file is attached", async () => {
    const artifact = {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn(async ({ data }) => ({ id: "artifact", ...data })),
    };
    const tx = { artifact, $queryRaw: vi.fn().mockResolvedValue([]) };
    const publishSpaceChange = vi.fn(async () => {});
    await attachWorkspaceFileToThread(
      {
        prisma: {
          artifact,
          $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
        } as unknown as PrismaClient,
        artifacts: { put: vi.fn().mockResolvedValue({ id: "stored" }) } as unknown as ArtifactStore,
        events: { publishSpaceChange },
      },
      {
        spaceId: "space",
        userId: "owner",
        botId: "bot",
        runId: "run",
        filePath: "report.pdf",
        bytes: new Uint8Array([1]),
        operationId: "op",
      },
    );
    expect(publishSpaceChange).toHaveBeenCalledExactlyOnceWith("space", "artifacts");
  });
  it("keeps a bot's attached file on its id path, with no stored computer path", async () => {
    const artifact = {
      findFirst: vi.fn().mockResolvedValue(null),
      // The column's default when a write leaves it out.
      create: vi.fn(async ({ data }) => ({ id: "artifact-7", computerPath: null, ...data })),
    };
    const tx = { artifact, $queryRaw: vi.fn().mockResolvedValue([]) };
    const attached: Array<{ id: string; mimeType: string; computerPath: string | null }> = [];
    await attachWorkspaceFileToThread(
      {
        prisma: {
          artifact,
          $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
        } as unknown as PrismaClient,
        artifacts: { put: vi.fn().mockResolvedValue({ id: "stored" }) } as unknown as ArtifactStore,
      },
      {
        spaceId: "space",
        userId: "owner",
        botId: "bot",
        runId: "run",
        filePath: "report.pdf",
        bytes: new Uint8Array([1, 2, 3]),
        operationId: "op",
        onAttached: async (_tx, row) => {
          attached.push(row);
        },
      },
    );
    expect(attached).toHaveLength(1);
    expect(attached[0]?.computerPath).toBeNull();
    expect(attachmentComputerPathFor(attached[0]!)).toBe("attachments/artifact-7.pdf");
  });
  it("rejects generated output above a lower configured attachment limit before storage", async () => {
    const put = vi.fn();
    await expect(
      attachWorkspaceFileToThread(
        {
          prisma: {} as PrismaClient,
          artifacts: { put } as unknown as ArtifactStore,
          maxUploadSizeBytes: 3,
        },
        {
          spaceId: "space",
          userId: "owner",
          botId: "bot",
          runId: "run",
          filePath: "generated.mp4",
          bytes: new Uint8Array(4),
          operationId: "op",
        },
      ),
    ).rejects.toThrow("attachment limit");
    expect(put).not.toHaveBeenCalled();
  });
  it("does not start the computer for a turn without attachments", async () => {
    const computer = vi.fn(async () => ({}) as ComputerRef);
    const files = await materializeCurrentTurnFiles(
      {
        prisma: {} as PrismaClient,
        artifacts: {} as ArtifactStore,
        sandbox: {} as SandboxProvider,
      },
      [{ kind: "text", text: "Sweep the inbox" }],
      {
        context: {
          operationId: "run-1",
          traceId: "run-1",
          spaceId: "space-1",
          userId: "user-1",
          botId: "bot-1",
          signal: new AbortController().signal,
        },
        computer,
        computerMode: "team",
      },
    );
    expect(files).toEqual([]);
    expect(computer).not.toHaveBeenCalled();
  });
  it("materializes uploads above 10 MiB when allowed by the server", async () => {
    const bytes = new Uint8Array(11 * 1024 * 1024);
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const deps = {
      prisma: {
        artifact: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "file-1",
              storageKey: "stored-1",
              name: "notes.txt",
              mimeType: "text/plain",
              size: bytes.length,
            },
          ]),
        },
      } as unknown as PrismaClient,
      artifacts: { get: vi.fn().mockResolvedValue(bytes) } as unknown as ArtifactStore,
      sandbox: { writeFile } as unknown as SandboxProvider,
      maxUploadSizeBytes: 12 * 1024 * 1024,
    };
    const blocks: MessageBlock[] = [
      {
        kind: "file",
        artifactId: "file-1",
        name: "notes.txt",
        mimeType: "text/plain",
        size: bytes.length,
      },
    ];
    const input = {
      context: {
        operationId: "run-1",
        traceId: "run-1",
        spaceId: "space-1",
        userId: "user-1",
        botId: "bot-1",
        signal: new AbortController().signal,
      },
      computer: async () =>
        ({ id: "computer-1", kind: "fake", providerRef: "fake-1" }) as ComputerRef,
      computerMode: "team" as const,
    };
    await expect(materializeCurrentTurnFiles(deps, blocks, input)).resolves.toHaveLength(1);
    expect(writeFile).toHaveBeenCalledOnce();
    writeFile.mockClear();
    await expect(
      materializeCurrentTurnFiles({ ...deps, maxUploadSizeBytes: 2 * 1024 * 1024 }, blocks, input),
    ).rejects.toThrow("2 MiB limit");
    expect(writeFile).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "checkpoints attachment creation in its transaction (failure: %s)",
    async (fail) => {
      const row = {
        id: "artifact",
        name: "generated.mp4",
        mimeType: "video/mp4",
        size: 4,
        storageKey: "stored",
      };
      const artifact = {
        findFirst: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(row),
      };
      const tx = { artifact, $queryRaw: vi.fn().mockResolvedValue([]) };
      const remove = vi.fn().mockResolvedValue(undefined);
      const onAttached = vi.fn(async (client, attached) => {
        expect(client).toBe(tx);
        expect(attached).toBe(row);
        if (fail) throw new Error("checkpoint failed");
      });
      const result = attachWorkspaceFileToThread(
        {
          prisma: {
            artifact,
            $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx),
          } as unknown as PrismaClient,
          artifacts: {
            put: vi.fn().mockResolvedValue({ id: "stored" }),
            remove,
          } as unknown as ArtifactStore,
        },
        {
          spaceId: "space",
          userId: "owner",
          botId: "bot",
          runId: "run",
          filePath: "generated.mp4",
          bytes: new Uint8Array([1, 2, 3, 4]),
          operationId: "op",
          onAttached,
        },
      );
      if (fail) {
        await expect(result).rejects.toThrow("checkpoint failed");
        expect(remove).toHaveBeenCalledWith("stored", expect.anything());
      } else {
        await expect(result).resolves.toMatchObject({
          artifactId: "artifact",
          block: { kind: "file", mimeType: "video/mp4" },
        });
        expect(remove).not.toHaveBeenCalled();
      }
      expect(onAttached).toHaveBeenCalledTimes(1);
    },
  );
  it("removes stored bytes when artifact metadata cannot be created", async () => {
    const remove = vi.fn().mockResolvedValue(undefined);
    const failure = new Error("database unavailable");
    const artifact = {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockRejectedValue(failure),
    };
    const tx = { artifact, $queryRaw: vi.fn().mockResolvedValue([{ lock: "1" }]) };

    await expect(
      attachWorkspaceFileToThread(
        {
          prisma: {
            artifact,
            $transaction: async (run: (client: typeof tx) => Promise<unknown>) => run(tx),
          } as unknown as PrismaClient,
          artifacts: {
            put: vi.fn().mockResolvedValue({ id: "stored-1", hash: "hash" }),
            remove,
          } as unknown as ArtifactStore,
        },
        {
          spaceId: "workspace-1",
          userId: "user-1",
          botId: "bot-1",
          runId: "run-1",
          filePath: "report.pdf",
          bytes: new Uint8Array([1, 2, 3]),
          operationId: "attach-1",
        },
      ),
    ).rejects.toBe(failure);
    expect(remove).toHaveBeenCalledWith(
      "stored-1",
      expect.objectContaining({ spaceId: "workspace-1", botId: "bot-1" }),
    );
  });

  it.each([
    ["video/mp4", ".mp4"],
    ["audio/mpeg", ".mp3"],
    ["audio/wav", ".wav"],
    ["audio/ogg", ".ogg"],
    ["audio/mp4", ".m4a"],
    ["application/pdf", ".pdf"],
    ["application/zip", ".zip"],
    ["application/vnd.rar", ".rar"],
    ["application/x-7z-compressed", ".7z"],
  ])(
    "copies %s attachments into the bot workspace and describes their paths",
    async (mimeType, extension) => {
      const findMany = vi.fn().mockResolvedValue([
        {
          id: "artifact-1",
          spaceId: "workspace-1",
          botId: "bot-1",
          name: `../quarterly report${extension}`,
          mimeType,
          size: 4,
          storageKey: "stored-1",
        },
      ]);
      const get = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
      const writeFile = vi.fn().mockResolvedValue(undefined);
      const markWorkspaceDirty = vi.fn();
      const context: AdapterContext & { botId: string } = {
        operationId: "run-1",
        traceId: "run-1",
        spaceId: "workspace-1",
        userId: "user-1",
        botId: "bot-1",
        runId: "run-1",
        signal: new AbortController().signal,
      };
      const computer: ComputerRef = {
        id: "computer-1",
        botId: "bot-1",
        kind: "fake",
        providerRef: "fake-1",
      };
      const blocks: MessageBlock[] = [
        {
          kind: "file",
          artifactId: "artifact-1",
          name: `../quarterly report${extension}`,
          mimeType,
          size: 4,
        },
      ];

      const files = await materializeCurrentTurnFiles(
        {
          prisma: { artifact: { findMany } } as unknown as PrismaClient,
          artifacts: { get } as unknown as ArtifactStore,
          sandbox: { writeFile } as unknown as SandboxProvider,
        },
        blocks,
        { context, computer: async () => computer, computerMode: "team", markWorkspaceDirty },
      );

      expect(get).toHaveBeenCalledWith("stored-1", context);
      expect(writeFile).toHaveBeenCalledWith(
        computer,
        {
          path: `bots/bot-1/attachments/artifact-1${extension}`,
          content: new Uint8Array([1, 2, 3, 4]),
        },
        context,
      );
      expect(markWorkspaceDirty).toHaveBeenCalledOnce();
      expect(markWorkspaceDirty.mock.invocationCallOrder[0]).toBeLessThan(
        writeFile.mock.invocationCallOrder[0]!,
      );
      expect(files).toEqual([
        {
          artifactId: "artifact-1",
          name: `../quarterly report${extension}`,
          mimeType,
          size: 4,
          path: `attachments/artifact-1${extension}`,
        },
      ]);
      expect(currentTurnFilesInstruction(files)).toContain(`"attachments/artifact-1${extension}"`);
    },
  );

  it("also materializes image attachments, not just files", async () => {
    // Inline vision alone would leave a bot unable to forward or hand the photo to a tool.
    const findMany = vi.fn().mockResolvedValue([
      {
        id: "image-1",
        spaceId: "workspace-1",
        botId: "bot-1",
        name: "photo.png",
        mimeType: "image/png",
        size: 4,
        storageKey: "stored-image-1",
      },
    ]);
    const get = vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4]));
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const files = await materializeCurrentTurnFiles(
      {
        prisma: { artifact: { findMany } } as unknown as PrismaClient,
        artifacts: { get } as unknown as ArtifactStore,
        sandbox: { writeFile } as unknown as SandboxProvider,
      },
      [
        {
          kind: "image",
          artifactId: "image-1",
          name: "photo.png",
          mimeType: "image/png",
        },
      ],
      {
        context: {
          operationId: "run-1",
          traceId: "run-1",
          spaceId: "workspace-1",
          userId: "user-1",
          botId: "bot-1",
          signal: new AbortController().signal,
        },
        computer: async () => ({
          id: "computer-1",
          botId: "bot-1",
          kind: "fake",
          providerRef: "fake-1",
        }),
        computerMode: "team",
      },
    );

    expect(get).toHaveBeenCalledWith("stored-image-1", expect.objectContaining({ botId: "bot-1" }));
    expect(writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "computer-1" }),
      { path: "bots/bot-1/attachments/image-1.png", content: new Uint8Array([1, 2, 3, 4]) },
      expect.objectContaining({ botId: "bot-1" }),
    );
    expect(files).toEqual([
      {
        artifactId: "image-1",
        name: "photo.png",
        mimeType: "image/png",
        size: 4,
        path: "attachments/image-1.png",
      },
    ]);
  });
});

describe("recent thread files", () => {
  it.each(["team", "dedicated"] as const)(
    "preserves edited recent files and lists them in %s mode",
    async (computerMode) => {
      const block = {
        kind: "file" as const,
        artifactId: "notes",
        name: "notes.txt",
        mimeType: "text/plain",
        size: 8,
      };
      const get = vi.fn().mockRejectedValue(new Error("original unavailable"));
      // The bot edited the copy, so its size no longer matches the stored original.
      const listFiles = vi.fn().mockResolvedValue([
        {
          path:
            computerMode === "team" ? "bots/bot/attachments/notes.txt" : "attachments/notes.txt",
          kind: "file",
          size: 6,
        },
      ]);
      const readFile = vi.fn();
      const writeFile = vi.fn();
      const markWorkspaceDirty = vi.fn();
      const files = await materializeRecentThreadFiles(
        {
          prisma: {
            artifact: {
              findMany: vi
                .fn()
                .mockResolvedValue([{ ...block, id: "notes", storageKey: "stored" }]),
            },
          } as unknown as PrismaClient,
          artifacts: { get } as unknown as ArtifactStore,
          sandbox: { listFiles, readFile, writeFile } as unknown as SandboxProvider,
        },
        [{ id: "earlier", role: "user" }],
        [{ id: "earlier", blocks: [block] }],
        {
          context: {
            operationId: "run",
            traceId: "run",
            spaceId: "space",
            userId: "user",
            botId: "bot",
            signal: new AbortController().signal,
          },
          computer: async () =>
            ({ id: "computer", kind: "fake", providerRef: "fake" }) as ComputerRef,
          computerMode,
          maxTurns: 3,
          markWorkspaceDirty,
        },
      );
      expect(listFiles).toHaveBeenCalledWith(
        expect.anything(),
        computerMode === "team" ? "bots/bot/attachments" : "attachments",
        expect.anything(),
      );
      expect(readFile).not.toHaveBeenCalled();
      expect(get).not.toHaveBeenCalled();
      expect(writeFile).not.toHaveBeenCalled();
      expect(markWorkspaceDirty).not.toHaveBeenCalled();
      expect(recentThreadFilesInstruction(files)).toContain('"attachments/notes.txt"');
    },
  );

  it.each([1, 3])("counts successful files within %s eligible turns", async (maxTurns) => {
    const block = (id: string): MessageBlock => ({
      kind: "file",
      artifactId: id,
      name: `${id}.txt`,
      mimeType: "text/plain",
      size: 3,
    });
    const findMany = vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in.map((id) => ({
        id,
        name: `${id}.txt`,
        mimeType: "text/plain",
        size: 3,
        storageKey: id,
      })),
    );
    const get = vi.fn(async (id: string) => {
      if (id.startsWith("missing")) throw new Error("unreadable");
      return new Uint8Array([1, 2, 3]);
    });
    const listFiles = vi.fn(async () => [
      { path: "bots/bot/attachments/existing.txt", kind: "file", size: 3 },
    ]);
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const markWorkspaceDirty = vi.fn();
    const files = await materializeRecentThreadFiles(
      {
        prisma: { artifact: { findMany } } as unknown as PrismaClient,
        artifacts: { get } as unknown as ArtifactStore,
        sandbox: { listFiles, writeFile } as unknown as SandboxProvider,
      },
      ["outside", "old", "middle", "new", "current"].map((id) => ({ id, role: "user" })),
      [
        { id: "outside", blocks: [block("outside")] },
        { id: "old", blocks: [block("extra"), block("last")] },
        { id: "middle", blocks: [block("second"), block("first"), block("existing")] },
        {
          id: "new",
          blocks: Array.from({ length: ATTACHMENT_MAX_COUNT }, (_, i) => block(`missing-${i}`)),
        },
        { id: "current", blocks: [block("current")] },
      ],
      {
        context: {
          operationId: "run",
          traceId: "run",
          spaceId: "space",
          userId: "user",
          botId: "bot",
          signal: new AbortController().signal,
        },
        computer: async () =>
          ({ id: "computer", kind: "fake", providerRef: "fake" }) as ComputerRef,
        computerMode: "team",
        maxTurns,
        skipMessageId: "current",
        markWorkspaceDirty,
      },
    );
    expect(files.map((file) => file.name)).toEqual(
      maxTurns === 1 ? [] : ["existing.txt", "first.txt", "second.txt", "last.txt"],
    );
    expect(files).toHaveLength(maxTurns === 1 ? 0 : ATTACHMENT_MAX_COUNT);
    expect(writeFile).toHaveBeenCalledTimes(maxTurns === 1 ? 0 : 3);
    expect(markWorkspaceDirty).not.toHaveBeenCalled();
    expect(get.mock.calls.map(([id]) => id)).toEqual([
      "missing-3",
      "missing-2",
      "missing-1",
      "missing-0",
      ...(maxTurns === 1 ? [] : ["first", "second", "last"]),
    ]);
  });

  it.each([
    [2, ["upload.png"]],
    [3, []],
  ])(
    "lists an old upload only within the last 3 user turns, after %s text-only turns",
    async (textTurns, listed) => {
      const upload: MessageBlock = {
        kind: "image",
        artifactId: "upload",
        name: "upload.png",
        mimeType: "image/png",
      };
      const textIds = Array.from({ length: textTurns }, (_, i) => `text-${i}`);
      const history = ["upload", ...textIds.flatMap((id) => [id, `reply-${id}`]), "current"].map(
        (id) => ({ id, role: id.startsWith("reply-") ? "assistant" : "user" }),
      );
      const messages = [
        { id: "upload", blocks: [upload] },
        ...textIds.map((id) => ({ id, blocks: [{ kind: "text" as const, text: id }] })),
      ];
      const files = await materializeRecentThreadFiles(
        {
          prisma: {
            artifact: {
              findMany: vi.fn().mockResolvedValue([
                {
                  id: "upload",
                  name: "upload.png",
                  mimeType: "image/png",
                  size: 3,
                  storageKey: "stored-upload",
                },
              ]),
            },
          } as unknown as PrismaClient,
          artifacts: {
            get: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
          } as unknown as ArtifactStore,
          sandbox: {
            listFiles: vi.fn().mockRejectedValue(new Error("missing")),
            writeFile: vi.fn().mockResolvedValue(undefined),
          } as unknown as SandboxProvider,
        },
        history,
        messages,
        {
          context: {
            operationId: "run",
            traceId: "run",
            spaceId: "space",
            userId: "user",
            botId: "bot",
            signal: new AbortController().signal,
          },
          computer: async () =>
            ({ id: "computer", kind: "fake", providerRef: "fake" }) as ComputerRef,
          computerMode: "team",
          maxTurns: 3,
          skipMessageId: "current",
        },
      );
      expect(files.map((file) => file.name)).toEqual(listed);
    },
  );

  it("copies attachments from earlier turns the run is answering, skipping unreadable ones", async () => {
    const findMany = vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
      where.id.in[0] === "image-1"
        ? [
            {
              id: "image-1",
              name: "screenshot.png",
              mimeType: "image/png",
              size: 3,
              storageKey: "stored-image-1",
            },
          ]
        : [],
    );
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const context = {
      operationId: "run-1",
      traceId: "run-1",
      spaceId: "space-1",
      userId: "user-1",
      botId: "bot-1",
      signal: new AbortController().signal,
    };
    const files = await materializeRecentThreadFiles(
      {
        prisma: { artifact: { findMany } } as unknown as PrismaClient,
        artifacts: {
          get: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3])),
        } as unknown as ArtifactStore,
        sandbox: {
          writeFile,
          listFiles: vi.fn().mockRejectedValue(new Error("missing")),
        } as unknown as SandboxProvider,
      },
      [
        { id: "transcript-image", role: "user" },
        { id: "reply", role: "assistant" },
        { id: "transcript-request", role: "user" },
        { id: "run-message", role: "user" },
      ],
      [
        {
          id: "transcript-image",
          blocks: [
            { kind: "text", text: "here it is" },
            { kind: "image", artifactId: "image-1", name: "screenshot.png", mimeType: "image/png" },
            { kind: "image", artifactId: "deleted-1", name: "old.png", mimeType: "image/png" },
          ],
        },
        { id: "reply", blocks: [{ kind: "text", text: "I can see it" }] },
        { id: "transcript-request", blocks: [{ kind: "text", text: "put it in Linear" }] },
        { id: "run-message", blocks: [{ kind: "text", text: "Slack message: put it in Linear" }] },
      ],
      {
        context,
        computer: async () =>
          ({ id: "computer-1", kind: "fake", providerRef: "fake-1" }) as ComputerRef,
        computerMode: "team",
        maxTurns: 3,
      },
    );

    expect(writeFile).toHaveBeenCalledOnce();
    expect(writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ id: "computer-1" }),
      { path: "bots/bot-1/attachments/image-1.png", content: new Uint8Array([1, 2, 3]) },
      context,
    );
    expect(recentThreadFilesInstruction(files)).toBe(
      [
        "Files attached earlier in this conversation, with their paths on your computer:",
        '- "screenshot.png" (image/png, 3 bytes): "attachments/image-1.png"',
      ].join("\n"),
    );
  });
});

describe("files listed by history tools", () => {
  it("marks the workspace dirty for a new copy so the run checkpoint keeps it", async () => {
    const block = {
      kind: "file" as const,
      artifactId: "lease",
      name: "lease.md",
      mimeType: "text/markdown",
      size: 5,
    };
    const writeFile = vi.fn();
    const markWorkspaceDirty = vi.fn();
    const deps = {
      prisma: {
        artifact: {
          findMany: vi.fn().mockResolvedValue([{ ...block, id: "lease", storageKey: "stored" }]),
        },
      } as unknown as PrismaClient,
      artifacts: { get: vi.fn().mockResolvedValue(new Uint8Array(5)) } as unknown as ArtifactStore,
      sandbox: {
        listFiles: vi.fn().mockRejectedValue(new Error("missing")),
        writeFile,
      } as unknown as SandboxProvider,
    };
    const input = {
      context: {
        operationId: "run",
        traceId: "run",
        spaceId: "space",
        userId: "user",
        botId: "bot",
        signal: new AbortController().signal,
      },
      computer: async () => ({ id: "computer", kind: "fake", providerRef: "fake" }) as ComputerRef,
      computerMode: "dedicated" as const,
      markWorkspaceDirty,
    };
    const files = await materializeEarlierFiles(deps, [block], input);
    expect(files.map((file) => file.path)).toEqual(["attachments/lease.md"]);
    expect(writeFile).toHaveBeenCalledOnce();
    expect(markWorkspaceDirty).toHaveBeenCalledOnce();
    // Recent-turn files are copied again on every computer start, so they stay out of it.
    markWorkspaceDirty.mockClear();
    await materializeRecentThreadFiles(
      deps,
      [{ id: "m", role: "user" }],
      [{ id: "m", blocks: [block] }],
      {
        ...input,
        maxTurns: 3,
      },
    );
    expect(markWorkspaceDirty).not.toHaveBeenCalled();
  });
});

describe("deleted files", () => {
  const block = {
    kind: "file" as const,
    artifactId: "deleted",
    name: "Dana lease.pdf",
    mimeType: "application/pdf",
    size: 5,
  };
  const deps = () => ({
    prisma: { artifact: { findMany: vi.fn().mockResolvedValue([]) } } as unknown as PrismaClient,
    artifacts: { get: vi.fn() } as unknown as ArtifactStore,
    sandbox: { listFiles: vi.fn(), writeFile: vi.fn() } as unknown as SandboxProvider,
  });
  const input = {
    context: {
      operationId: "run",
      traceId: "run",
      spaceId: "space",
      userId: "user",
      botId: "bot",
      signal: new AbortController().signal,
    },
    computer: async () => ({ id: "computer", kind: "fake", providerRef: "fake" }) as ComputerRef,
    computerMode: "dedicated" as const,
  };

  it("skips an earlier file whose original is gone, keeping its name out of the log", async () => {
    const sink = createTestSink();
    const previous = getLogger();
    installLogger(createLogger({ service: "rakazo-worker", sinks: [sink] }));
    onTestFinished(() => installLogger(previous));

    await expect(materializeEarlierFiles(deps(), [block], input)).resolves.toEqual([]);
    expect(JSON.stringify(sink.events)).not.toContain("Dana lease.pdf");
  });

  it("still fails a current-turn file whose original is gone", async () => {
    await expect(materializeCurrentTurnFiles(deps(), [block], input)).rejects.toThrow(
      "Attached file is unavailable: Dana lease.pdf",
    );
  });
});

describe("earlier file queue", () => {
  const file = (artifactId: string) => ({
    kind: "file" as const,
    artifactId,
    name: `${artifactId}.md`,
    mimeType: "text/markdown",
    size: 1,
  });

  it("keeps the newest listings, once each, and queues a file again after it was taken", () => {
    const queue = createEarlierFileQueue(2);
    queue.add([file("a"), file("b"), file("a")]);
    queue.add([file("c")]);
    expect(queue.take().map((f) => f.artifactId)).toEqual(["a", "c"]);
    expect(queue.take()).toEqual([]);
    // Listing it again retries a copy that failed.
    queue.add([file("a")]);
    expect(queue.take().map((f) => f.artifactId)).toEqual(["a"]);
  });

  it("skips files already copied to this computer until a new one starts", () => {
    const queue = createEarlierFileQueue();
    queue.add([file("a"), file("b")]);
    const taken = queue.take();
    queue.copiedTo(taken, [
      {
        artifactId: "a",
        name: "a.md",
        mimeType: "text/markdown",
        size: 1,
        path: "attachments/a.md",
      },
    ]);
    queue.add([file("a"), file("b")]);
    expect(queue.take().map((f) => f.artifactId)).toEqual(["b"]);
    queue.computerStarted();
    queue.add([file("a")]);
    expect(queue.take().map((f) => f.artifactId)).toEqual(["a"]);
  });
});

describe("attachments at their stored path", () => {
  const readablePath = "attachments/2026/11/2026-11-18_1649_Dana_photo.png";
  const context: AdapterContext & { botId: string } = {
    operationId: "run-1",
    traceId: "run-1",
    spaceId: "space-1",
    userId: "user-1",
    botId: "bot-1",
    signal: new AbortController().signal,
  };
  const computer = { id: "computer-1", kind: "fake", providerRef: "fake-1" } as ComputerRef;
  const block: MessageBlock = {
    kind: "image",
    artifactId: "image-1",
    name: "photo.png",
    mimeType: "image/png",
  };
  const setup = (
    computerPath: string | null,
    sandbox: { listFiles?: ReturnType<typeof vi.fn> } = {},
  ) => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const deps = {
      prisma: {
        artifact: {
          findMany: vi.fn().mockResolvedValue([
            {
              id: "image-1",
              name: "photo.png",
              mimeType: "image/png",
              size: 4,
              storageKey: "stored-1",
              computerPath,
            },
          ]),
        },
      } as unknown as PrismaClient,
      artifacts: {
        get: vi.fn().mockResolvedValue(new Uint8Array([1, 2, 3, 4])),
      } as unknown as ArtifactStore,
      sandbox: { writeFile, ...sandbox } as unknown as SandboxProvider,
    };
    const input = { context, computer: async () => computer, computerMode: "team" as const };
    return { deps, input, writeFile };
  };

  it("lists, writes and describes a file at its stored path, under the bot's folder on a team computer", async () => {
    const { deps, input, writeFile } = setup(readablePath);
    const listed = await listCurrentTurnFiles(deps, [block], context);
    expect(listed.map((file) => file.path)).toEqual([readablePath]);
    const files = await materializeCurrentTurnFiles(deps, [block], input);
    expect(files.map((file) => file.path)).toEqual([readablePath]);
    expect(writeFile).toHaveBeenCalledWith(
      computer,
      { path: `bots/bot-1/${readablePath}`, content: new Uint8Array([1, 2, 3, 4]) },
      context,
    );
    expect(currentTurnFilesInstruction(files)).toContain(`"${readablePath}"`);
  });

  it("keeps the id path for a row with no stored path and writes it without listing the folder", async () => {
    // Even a same-size copy at the id path is rewritten, as before stored paths existed.
    const listFiles = vi
      .fn()
      .mockResolvedValue([{ path: "bots/bot-1/attachments/image-1.png", kind: "file", size: 4 }]);
    const { deps, input, writeFile } = setup(null, { listFiles });
    const files = await materializeCurrentTurnFiles(deps, [block], input);
    expect(files.map((file) => file.path)).toEqual(["attachments/image-1.png"]);
    expect(listFiles).not.toHaveBeenCalled();
    expect(writeFile).toHaveBeenCalledWith(
      computer,
      expect.objectContaining({ path: "bots/bot-1/attachments/image-1.png" }),
      context,
    );
  });

  it.each([
    ["the path is listed with the same size", 4, false],
    ["the path is listed with another size", 9, true],
  ])("when %s, the write happens: %s", async (_name, listedSize, written) => {
    const listFiles = vi.fn().mockResolvedValue([
      { path: `bots/bot-1/${readablePath}`, kind: "file", size: listedSize },
      { path: "bots/bot-1/attachments/2026/11/other.png", kind: "file", size: 4 },
    ]);
    const { deps, input, writeFile } = setup(readablePath, { listFiles });
    await materializeCurrentTurnFiles(deps, [block], input);
    expect(listFiles).toHaveBeenCalledWith(computer, "bots/bot-1/attachments/2026/11", context);
    expect(writeFile).toHaveBeenCalledTimes(written ? 1 : 0);
  });

  it.each([
    ["a listing that throws", vi.fn().mockRejectedValue(new Error("no such folder"))],
    ["an empty listing", vi.fn().mockResolvedValue([])],
  ])("writes the file after %s", async (_name, listFiles) => {
    const { deps, input, writeFile } = setup(readablePath, { listFiles });
    await expect(materializeCurrentTurnFiles(deps, [block], input)).resolves.toHaveLength(1);
    expect(writeFile).toHaveBeenCalledOnce();
  });

  it("queues an earlier file again only when the copy did not return it", () => {
    const queue = createEarlierFileQueue();
    const taken = [
      { ...block, artifactId: "a" },
      { ...block, artifactId: "b" },
    ];
    queue.add(taken);
    queue.take();
    // The file was copied at its stored path, which no id-based rebuild would name.
    queue.copiedTo(taken, [
      { artifactId: "a", name: "photo.png", mimeType: "image/png", size: 4, path: readablePath },
    ]);
    queue.add(taken);
    expect(queue.take().map((file) => file.artifactId)).toEqual(["b"]);
  });
});

describe("files whose original was deleted", () => {
  const context = {
    operationId: "run",
    traceId: "run",
    spaceId: "space",
    userId: "user",
    botId: "bot",
    signal: new AbortController().signal,
  };
  const kept = {
    kind: "file" as const,
    artifactId: "kept",
    name: "kept.txt",
    mimeType: "text/plain",
    size: 3,
  };
  const gone = {
    kind: "file" as const,
    artifactId: "gone",
    name: "gone.txt",
    mimeType: "text/plain",
    size: 3,
  };
  const prisma = {
    artifact: {
      findMany: vi.fn().mockResolvedValue([{ ...kept, id: "kept", storageKey: "stored" }]),
    },
  } as unknown as PrismaClient;

  it("lists an earlier file with no row as no longer available, and the rest as before", async () => {
    const files = await listRecentThreadFiles(
      { prisma },
      [{ id: "m", role: "user" }],
      [{ id: "m", blocks: [gone, kept] }],
      { context, maxTurns: 3 },
    );
    const instruction = recentThreadFilesInstruction(files);
    expect(instruction).toContain('"attachments/kept.txt"');
    expect(instruction).toContain('"gone.txt"');
    expect(instruction).toContain("no longer available");
    expect(instruction).not.toContain("attachments/gone");
  });

  it("copies the files that remain and skips the deleted one without throwing", async () => {
    const writeFile = vi.fn();
    const files = await materializeEarlierFiles(
      {
        prisma,
        artifacts: {
          get: vi.fn().mockResolvedValue(new Uint8Array(3)),
        } as unknown as ArtifactStore,
        sandbox: {
          listFiles: vi.fn().mockRejectedValue(new Error("missing")),
          writeFile,
        } as unknown as SandboxProvider,
      },
      [gone, kept],
      {
        context,
        computer: async () =>
          ({ id: "computer", kind: "fake", providerRef: "fake" }) as ComputerRef,
        computerMode: "dedicated",
      },
    );
    expect(files.map((file) => file.artifactId)).toEqual(["kept"]);
    expect(writeFile).toHaveBeenCalledOnce();
  });
});
