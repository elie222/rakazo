import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, AgentHomeStore, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { LocalAgentHomeStore } from "../../storage/home.js";
import { copyAttachmentToComputer } from "./copy-attachment.js";

const context: AdapterContext = {
  operationId: "test",
  traceId: "test",
  spaceId: "space-1",
  userId: "user-1",
  botId: "bot-1",
  signal: new AbortController().signal,
};

const bytes = new Uint8Array([1, 2, 3]);

const STORED = "attachments/2026/11/2026-11-17_1912_972541234567_clip.mov";
const TEAM_PATH = `bots/bot-1/${STORED}`;

const input = { bot: { id: "bot-1", computerId: "computer-1" }, path: STORED, bytes };

type ComputerRow = {
  spaceId: string;
  scope: string;
  homeKey: string;
  kind: string;
  providerRef: string | null;
  state: string;
};

/** A database whose only computer is `row` and whose leases are always free. */
function fakeLeasePrisma(row: ComputerRow | null) {
  return {
    computer: {
      findFirst: vi.fn(async ({ where }: { where: { id: string; spaceId?: string } }) =>
        row && where.id === "computer-1" && (where.spaceId ?? row.spaceId) === row.spaceId
          ? row
          : null,
      ),
    },
    $queryRaw: vi.fn(async (query: TemplateStringsArray) =>
      query.join("").includes("INSERT INTO") ? [{ fence: 1n }] : [{}],
    ),
  } as unknown as PrismaClient;
}

function computerRow(computer: Partial<ComputerRow>): ComputerRow {
  return {
    spaceId: "space-1",
    scope: "team",
    homeKey: "team-home",
    kind: "docker",
    providerRef: null,
    state: "stopped",
    ...computer,
  };
}

function setup(computer: Partial<ComputerRow> | null, options: { persistentHome?: boolean } = {}) {
  const prisma = fakeLeasePrisma(computer && computerRow(computer));
  const writeBinaryFile = vi.fn(async () => undefined);
  const home = { writeBinaryFile } as unknown as AgentHomeStore;
  const writeFile = vi.fn(async () => undefined);
  const sandbox = {
    writeFile,
    describe: () => ({ capabilities: { persistentHome: options.persistentHome ?? false } }),
  } as unknown as SandboxProvider;
  const deps = { prisma, home, sandbox };
  return { deps, writeBinaryFile, writeFile };
}

describe("copyAttachmentToComputer", () => {
  it("writes into a running computer at the bot's stored path with the same bytes", async () => {
    const { deps, writeFile, writeBinaryFile } = setup({
      kind: "e2b",
      providerRef: "sbx-1",
      state: "running",
    });

    await expect(copyAttachmentToComputer(deps, input, context)).resolves.toEqual({
      copied: TEAM_PATH,
    });
    expect(writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "sbx-1", kind: "e2b" }),
      { path: TEAM_PATH, content: bytes },
      context,
    );
    expect(writeBinaryFile).not.toHaveBeenCalled();
  });

  it("writes a stopped Docker computer's file into its stored home", async () => {
    const { deps, writeBinaryFile, writeFile } = setup({ kind: "docker", state: "stopped" });

    await expect(copyAttachmentToComputer(deps, input, context)).resolves.toEqual({
      copied: TEAM_PATH,
    });
    expect(writeBinaryFile).toHaveBeenCalledWith("team-home", TEAM_PATH, bytes, context);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("writes a running Docker computer's file through its container, not its mounted home", async () => {
    const { deps, writeFile, writeBinaryFile } = setup({
      kind: "docker",
      providerRef: "ctr-1",
      state: "running",
    });

    await expect(copyAttachmentToComputer(deps, input, context)).resolves.toEqual({
      copied: TEAM_PATH,
    });
    expect(writeFile).toHaveBeenCalledWith(
      expect.objectContaining({ providerRef: "ctr-1", kind: "docker" }),
      { path: TEAM_PATH, content: bytes },
      context,
    );
    expect(writeBinaryFile).not.toHaveBeenCalled();
  });

  it.each([
    ["starting", { state: "booting", providerRef: null }],
    ["stopping", { state: "suspending", providerRef: "ctr-1" }],
    ["stopped with its container kept", { state: "stopped", providerRef: "ctr-1" }],
  ])("skips a Docker computer %s, whose container may mount its home", async (_label, row) => {
    const { deps, writeBinaryFile, writeFile } = setup({ kind: "docker", ...row });

    await expect(copyAttachmentToComputer(deps, input, context)).resolves.toEqual({
      skipped: "home_not_reachable",
    });
    expect(writeBinaryFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("writes an asleep Docker computer's file into its home, as its container is stopped", async () => {
    const { deps, writeBinaryFile, writeFile } = setup({
      kind: "docker",
      state: "suspended",
      providerRef: "ctr-1",
    });

    await expect(copyAttachmentToComputer(deps, input, context)).resolves.toEqual({
      copied: TEAM_PATH,
    });
    expect(writeBinaryFile).toHaveBeenCalledWith("team-home", TEAM_PATH, bytes, context);
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("skips an asleep remote computer, which resumes on its own disk", async () => {
    const { deps, writeBinaryFile, writeFile } = setup({
      kind: "e2b",
      state: "suspended",
      providerRef: "sbx-1",
    });

    await expect(copyAttachmentToComputer(deps, input, context)).resolves.toEqual({
      skipped: "home_not_reachable",
    });
    expect(writeBinaryFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("writes the stored home of a stopped remote computer the next start restores", async () => {
    const { deps, writeBinaryFile } = setup({ kind: "e2b", state: "stopped", providerRef: null });

    await expect(copyAttachmentToComputer(deps, input, context)).resolves.toEqual({
      copied: TEAM_PATH,
    });
    expect(writeBinaryFile).toHaveBeenCalledWith("team-home", TEAM_PATH, bytes, context);
  });

  it("skips a stopped remote computer that keeps its own disk, which a start resumes", async () => {
    const { deps, writeBinaryFile, writeFile } = setup({
      kind: "e2b",
      state: "stopped",
      providerRef: "sbx-1",
    });

    await expect(copyAttachmentToComputer(deps, input, context)).resolves.toEqual({
      skipped: "home_not_reachable",
    });
    expect(writeBinaryFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("skips a stopped computer whose stored home the server does not hold", async () => {
    const { deps, writeBinaryFile } = setup({ kind: "fake", state: "stopped" });

    await expect(copyAttachmentToComputer(deps, input, context)).resolves.toEqual({
      skipped: "home_not_reachable",
    });
    expect(writeBinaryFile).not.toHaveBeenCalled();
  });

  it("skips a remote computer between states, whose save or restore could drop the file", async () => {
    const { deps, writeBinaryFile } = setup({ kind: "e2b", state: "suspending", providerRef: "x" });

    await expect(copyAttachmentToComputer(deps, input, context)).resolves.toEqual({
      skipped: "home_not_reachable",
    });
    expect(writeBinaryFile).not.toHaveBeenCalled();
  });

  it("skips a stored home that a persistent claim may hold instead", async () => {
    const { deps, writeBinaryFile } = setup(
      { kind: "kubernetes", state: "stopped" },
      { persistentHome: true },
    );

    await expect(copyAttachmentToComputer(deps, input, context)).resolves.toEqual({
      skipped: "home_not_reachable",
    });
    expect(writeBinaryFile).not.toHaveBeenCalled();
  });

  it("skips a bot without a computer", async () => {
    const { deps, writeBinaryFile, writeFile } = setup(null);

    await expect(
      copyAttachmentToComputer(deps, { ...input, bot: { id: "bot-1", computerId: null } }, context),
    ).resolves.toEqual({ skipped: "no_computer" });
    await expect(copyAttachmentToComputer(deps, input, context)).resolves.toEqual({
      skipped: "no_computer",
    });
    expect(writeBinaryFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("skips a computer of another Space than the message's", async () => {
    const { deps, writeBinaryFile, writeFile } = setup({ spaceId: "space-2" });

    await expect(copyAttachmentToComputer(deps, input, context)).resolves.toEqual({
      skipped: "no_computer",
    });
    expect(writeBinaryFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("copies to the stored path itself on a dedicated computer", async () => {
    const { deps, writeBinaryFile } = setup({ scope: "dedicated", kind: "docker" });

    await expect(copyAttachmentToComputer(deps, input, context)).resolves.toEqual({
      copied: STORED,
    });
    expect(writeBinaryFile).toHaveBeenCalledWith("team-home", STORED, bytes, context);
  });

  it("leaves a file already at the path in the stored home as it is", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-attachment-copy-"));
    onTestFinished(() => rm(root, { recursive: true, force: true }));
    const home = new LocalAgentHomeStore(root);
    const prisma = fakeLeasePrisma(computerRow({}));
    const deps = { prisma, home, sandbox: {} as SandboxProvider };
    const first = new Uint8Array([1]);

    await expect(
      copyAttachmentToComputer(deps, { ...input, bytes: first }, context),
    ).resolves.toEqual({ copied: TEAM_PATH });
    await expect(
      copyAttachmentToComputer(deps, { ...input, bytes: new Uint8Array([2]) }, context),
    ).resolves.toEqual({ skipped: "already_there" });
    expect(await readFile(path.join(home.pathFor("team-home"), TEAM_PATH))).toEqual(
      Buffer.from(first),
    );
  });

  it.each([
    ["the team's shared folder", "shared/notes.txt"],
    ["the workspace root", "clip.mov"],
    ["a parent folder", "attachments/../clip.mov"],
    ["another bot's folder", "/home/rakazo/bots/bot-2/attachments/clip.mov"],
  ])("refuses a path outside the bot's attachments folder: %s", async (_label, stored) => {
    const { deps, writeBinaryFile, writeFile } = setup({ kind: "docker" });

    await expect(
      copyAttachmentToComputer(deps, { ...input, path: stored }, context),
    ).rejects.toThrow();
    expect(writeBinaryFile).not.toHaveBeenCalled();
    expect(writeFile).not.toHaveBeenCalled();
  });

  it("holds the computer's attachment copies while it reads the computer and writes", async () => {
    const { deps, writeBinaryFile } = setup({ kind: "docker" });

    await copyAttachmentToComputer(deps, input, context);

    const queryRaw = vi.mocked(deps.prisma.$queryRaw).mock;
    const queries = queryRaw.calls.map(([query, ...values]) => ({
      sql: (query as TemplateStringsArray).join("?"),
      values,
    }));
    expect(queries[0]!.sql).toContain("INSERT INTO");
    expect(queries[0]!.values).toContain("attachment-copies:computer-1");
    expect(queries.at(-1)!.sql).toContain("DELETE FROM");
    const taken = queryRaw.invocationCallOrder[0]!;
    const released = queryRaw.invocationCallOrder.at(-1)!;
    // The computer is read under the lease too, so its state is the latest before the write.
    const read = vi.mocked(deps.prisma.computer.findFirst);
    for (const order of [read, writeBinaryFile].map((call) => call.mock.invocationCallOrder[0]!)) {
      expect(order).toBeGreaterThan(taken);
      expect(order).toBeLessThan(released);
    }
  });

  it("passes on a write that fails for another reason", async () => {
    const { deps, writeFile } = setup({ kind: "e2b", providerRef: "sbx-1", state: "running" });
    writeFile.mockRejectedValueOnce(new Error("permission denied"));

    await expect(copyAttachmentToComputer(deps, input, context)).rejects.toThrow(
      "permission denied",
    );
  });
});
