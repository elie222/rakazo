import type {
  AdapterContext,
  AgentHomeStore,
  ComputerFileEntry,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import { saveReceivedFile } from "./save-received-file.js";

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

const bytes = new Uint8Array([1, 2, 3]);

const input = {
  bot: { id: "bot-1", computerId: "computer-1" },
  sender: "972541234567",
  name: "clip",
  mimeType: "video/quicktime",
  bytes,
  at: new Date("2026-11-17T17:12:00Z"),
};

const TEAM_PATH = "shared/received/2026/11/2026-11-17_1912_972541234567_clip.mov";

type ComputerRow = {
  scope: string;
  homeKey: string;
  kind: string;
  providerRef: string | null;
  state: string;
};

function setup(
  computer: Partial<ComputerRow> | null,
  options: {
    homeFiles?: string[];
    computerFiles?: Record<string, ComputerFileEntry[] | Error>;
    persistentHome?: boolean;
  } = {},
) {
  const row: ComputerRow | null = computer && {
    scope: "team",
    homeKey: "team-home",
    kind: "docker",
    providerRef: null,
    state: "stopped",
    ...computer,
  };
  const prisma = {
    computer: { findUnique: vi.fn(async () => row) },
  } as unknown as PrismaClient;
  const homeList = vi.fn(async (_homeKey: string, directory: string) =>
    (options.homeFiles ?? [])
      .filter((file) => file.startsWith(`${directory}/`))
      .map((file) => ({ path: file, kind: "file" as const, size: 1 })),
  );
  const writeBinaryFile = vi.fn(async () => undefined);
  const home = { list: homeList, writeBinaryFile } as unknown as AgentHomeStore;
  const listFiles = vi.fn(async (_computer: unknown, directory: string) => {
    const listed = options.computerFiles?.[directory];
    if (listed instanceof Error) throw listed;
    if (!listed) throw new Error(`find: '${directory}': No such file or directory`);
    return listed;
  });
  const writeFile = vi.fn(async () => undefined);
  const sandbox = {
    listFiles,
    writeFile,
    describe: () => ({ capabilities: { persistentHome: options.persistentHome ?? false } }),
  } as unknown as SandboxProvider;
  const deps = { prisma, home, sandbox, timeZone: "Asia/Jerusalem" };
  return { deps, homeList, writeBinaryFile, listFiles, writeFile };
}

describe("saveReceivedFile", () => {
  it("writes into a running computer at the team path with the same bytes", async () => {
    const { deps, writeFile, writeBinaryFile } = setup(
      { kind: "e2b", providerRef: "sbx-1", state: "running" },
      { computerFiles: { "shared/received/2026/11": [] } },
    );

    await expect(saveReceivedFile(deps, input, context)).resolves.toEqual({ saved: TEAM_PATH });
    expect(writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "sbx-1", kind: "e2b" }),
      { path: TEAM_PATH, content: bytes },
      context,
    );
    expect(writeBinaryFile).not.toHaveBeenCalled();
  });

  it("writes a stopped Docker computer's file into its stored home", async () => {
    const { deps, writeBinaryFile, writeFile } = setup({ kind: "docker", state: "stopped" });

    await expect(saveReceivedFile(deps, input, context)).resolves.toEqual({ saved: TEAM_PATH });
    expect(writeBinaryFile).toHaveBeenCalledWith("team-home", TEAM_PATH, bytes, context);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("writes the stored home of a stopped remote computer the next start restores", async () => {
    const { deps, writeBinaryFile } = setup({ kind: "e2b", state: "stopped", providerRef: null });

    await expect(saveReceivedFile(deps, input, context)).resolves.toEqual({ saved: TEAM_PATH });
    expect(writeBinaryFile).toHaveBeenCalledWith("team-home", TEAM_PATH, bytes, context);
  });

  it("skips a stopped remote computer that keeps its own disk, which a start resumes", async () => {
    const { deps, writeBinaryFile, writeFile } = setup({
      kind: "e2b",
      state: "stopped",
      providerRef: "sbx-1",
    });

    await expect(saveReceivedFile(deps, input, context)).resolves.toEqual({
      skipped: "home_not_reachable",
    });
    expect(writeBinaryFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("skips a stopped computer whose stored home the server does not hold", async () => {
    const { deps, writeBinaryFile } = setup({ kind: "fake", state: "stopped" });

    await expect(saveReceivedFile(deps, input, context)).resolves.toEqual({
      skipped: "home_not_reachable",
    });
    expect(writeBinaryFile).not.toHaveBeenCalled();
  });

  it("skips a remote computer between states, whose save or restore could drop the file", async () => {
    const { deps, writeBinaryFile } = setup({ kind: "e2b", state: "suspending", providerRef: "x" });

    await expect(saveReceivedFile(deps, input, context)).resolves.toEqual({
      skipped: "home_not_reachable",
    });
    expect(writeBinaryFile).not.toHaveBeenCalled();
  });

  it("skips a stored home that a persistent claim may hold instead", async () => {
    const { deps, writeBinaryFile } = setup(
      { kind: "kubernetes", state: "stopped" },
      { persistentHome: true },
    );

    await expect(saveReceivedFile(deps, input, context)).resolves.toEqual({
      skipped: "home_not_reachable",
    });
    expect(writeBinaryFile).not.toHaveBeenCalled();
  });

  it("skips a bot without a computer", async () => {
    const { deps, writeBinaryFile, writeFile } = setup(null);

    await expect(
      saveReceivedFile(deps, { ...input, bot: { id: "bot-1", computerId: null } }, context),
    ).resolves.toEqual({ skipped: "no_computer" });
    await expect(saveReceivedFile(deps, input, context)).resolves.toEqual({
      skipped: "no_computer",
    });
    expect(writeBinaryFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("saves at the root received folder of a dedicated computer", async () => {
    const { deps, writeBinaryFile } = setup({ scope: "dedicated", kind: "docker" });

    await expect(saveReceivedFile(deps, input, context)).resolves.toEqual({
      saved: "received/2026/11/2026-11-17_1912_972541234567_clip.mov",
    });
    expect(writeBinaryFile).toHaveBeenCalledWith(
      "team-home",
      "received/2026/11/2026-11-17_1912_972541234567_clip.mov",
      bytes,
      context,
    );
  });

  it("keeps framing characters out of the path the bot is told", async () => {
    const { deps } = setup({ kind: "docker" });

    await expect(
      saveReceivedFile(deps, { ...input, name: 'clip] "now" [x', sender: "a\nb" }, context),
    ).resolves.toEqual({
      saved: "shared/received/2026/11/2026-11-17_1912_a b_clip now x.mov",
    });
  });

  it("never replaces a file already in the stored home", async () => {
    const { deps, homeList, writeBinaryFile } = setup(
      { kind: "docker" },
      { homeFiles: [TEAM_PATH, TEAM_PATH.replace(".mov", "-2.mov")] },
    );

    const result = await saveReceivedFile(deps, input, context);

    expect(result).toEqual({ saved: TEAM_PATH.replace(".mov", "-3.mov") });
    expect(homeList).toHaveBeenCalledWith("team-home", "shared/received/2026/11", context);
    expect(writeBinaryFile).toHaveBeenCalledWith(
      "team-home",
      TEAM_PATH.replace(".mov", "-3.mov"),
      bytes,
      context,
    );
  });

  it("never replaces a file already on a running computer", async () => {
    const { deps, writeFile } = setup(
      { kind: "e2b", providerRef: "sbx-1", state: "running" },
      {
        computerFiles: {
          "shared/received/2026/11": [{ path: TEAM_PATH, kind: "file", size: 1 }],
        },
      },
    );

    await expect(saveReceivedFile(deps, input, context)).resolves.toEqual({
      saved: TEAM_PATH.replace(".mov", "-2.mov"),
    });
    expect(writeFile).toHaveBeenCalledWith(
      expect.anything(),
      { path: TEAM_PATH.replace(".mov", "-2.mov"), content: bytes },
      context,
    );
  });

  it("starts a month folder a running computer does not have yet", async () => {
    const { deps, writeFile } = setup(
      { kind: "e2b", providerRef: "sbx-1", state: "running" },
      { computerFiles: { shared: [{ path: "shared/notes.txt", kind: "file", size: 1 }] } },
    );

    await expect(saveReceivedFile(deps, input, context)).resolves.toEqual({ saved: TEAM_PATH });
    expect(writeFile).toHaveBeenCalledOnce();
  });

  it("writes nothing when a folder that is there cannot be read", async () => {
    const { deps, writeFile } = setup(
      { kind: "e2b", providerRef: "sbx-1", state: "running" },
      {
        computerFiles: {
          "shared/received/2026/11": new Error("permission denied"),
          "shared/received/2026": [{ path: "shared/received/2026/11", kind: "dir", size: 0 }],
        },
      },
    );

    await expect(saveReceivedFile(deps, input, context)).rejects.toThrow("permission denied");
    expect(writeFile).not.toHaveBeenCalled();
  });
});
