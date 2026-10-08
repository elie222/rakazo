import { execFileSync } from "node:child_process";
import { access, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { CommandRequest, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkpointComputerWorkspace,
  ensureComputerWorkspaceLayout,
  removeComputerWorkspaceDirectories,
  removeDeletedBotWorkspaces,
  restoreComputerWorkspace,
  teamBrowserProfileName,
} from "./computer-workspace.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";

const context = {
  operationId: "workspace-test",
  traceId: "workspace-test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("provider-neutral computer workspace", () => {
  it("prepares shared and bot folders for a Team Computer", async () => {
    const provider = new FakeSandboxProvider();
    const computer = await provider.provision(
      { botId: "team-workspace", homePath: "/ignored" },
      context,
    );
    const execute = vi.spyOn(provider, "execute");

    await ensureComputerWorkspaceLayout(provider, computer, "team", "bot-1", context);

    expect(execute).toHaveBeenCalledWith(
      computer,
      { argv: ["mkdir", "-p", "shared", "bots/bot-1"] },
      context,
    );
  });

  it("restores a checkpoint into a replacement provider machine", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "rakazo-workspace-store-"));
    roots.push(root);
    const home = new LocalAgentHomeStore(root);
    const firstProvider = new FakeSandboxProvider();
    const first = await firstProvider.provision({ botId: "bot-1", homePath: "/ignored" }, context);

    await firstProvider.writeFile(
      first,
      { path: "notes/result.txt", content: new TextEncoder().encode("portable") },
      context,
    );
    const revision = await checkpointComputerWorkspace(
      home,
      firstProvider,
      "bot-1",
      first,
      context,
    );

    const replacementProvider = new FakeSandboxProvider();
    const replacement = await replacementProvider.provision(
      { botId: "bot-1", homePath: "/different-provider" },
      context,
    );
    await restoreComputerWorkspace(home, replacementProvider, "bot-1", replacement, context);

    expect(revision).toMatch(/^rev-/);
    expect(
      new TextDecoder().decode(
        await replacementProvider.readFile(replacement, "notes/result.txt", context),
      ),
    ).toBe("portable");
  });
});

describe("Team run checkpoints", () => {
  it("defers a remote export when another run prevents an exclusive checkpoint", async () => {
    const { checkpointRunComputerWorkspace } = await import("./computer-workspace.js");
    const exportWorkspace = vi.fn();
    const updateMany = vi.fn().mockResolvedValue({ count: 0 });
    const deps = { sandbox: { exportWorkspace }, home: {}, prisma: { computer: { updateMany } } };
    const result = await checkpointRunComputerWorkspace(
      deps as never,
      { id: "team", homeKey: "team", scope: "team" },
      { id: "remote", providerRef: "remote", kind: "e2b", botId: "team" },
      { ...context, botId: "writer", screenLeaseId: "run-a:2" },
    );
    expect(result).toBeUndefined();
    expect(exportWorkspace).not.toHaveBeenCalled();
    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          state: "running",
          executionLeases: {
            none: { expiresAt: { gt: expect.any(Date) }, NOT: { runId: "run-a", fence: 2 } },
          },
        }),
        data: expect.objectContaining({ state: "suspending" }),
      }),
    );
  });

  it("restores the running state when an exclusive remote export fails", async () => {
    const { checkpointRunComputerWorkspace } = await import("./computer-workspace.js");
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const exportWorkspace = vi.fn(async function* () {
      await Promise.reject(new Error("export failed"));
      yield { path: "unreachable", content: new Uint8Array() };
    });
    const deps = { sandbox: { exportWorkspace }, home: {}, prisma: { computer: { updateMany } } };
    await expect(
      checkpointRunComputerWorkspace(
        deps as never,
        { id: "team", homeKey: "team", scope: "team" },
        { id: "remote", providerRef: "remote", kind: "box", botId: "team" },
        { ...context, botId: "writer", screenLeaseId: "run-a:2" },
      ),
    ).rejects.toThrow("export failed");
    expect(updateMany.mock.invocationCallOrder[0]).toBeLessThan(
      exportWorkspace.mock.invocationCallOrder[0]!,
    );
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: "team", providerRef: "remote", state: "suspending" },
      data: { state: "running" },
    });
  });
});

describe("Team bot folder cleanup", () => {
  const computer: ComputerRef = {
    id: "sandbox-1",
    botId: "team-workspace",
    kind: "createos",
    providerRef: "sandbox-1",
  };

  function deletedBots(...ids: string[]) {
    const findMany = vi.fn().mockResolvedValue(ids.map((id) => ({ id })));
    return { findMany, prisma: { botDeletion: { findMany } } as unknown as PrismaClient };
  }

  it("removes only folders of bots deleted from this space when a Team Computer wakes", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "rakazo-team-wake-"));
    roots.push(workspace);
    await seedFile(workspace, "bots/deleted-bot/private.txt", "gone");
    await seedFile(workspace, "bots/deleted-bot-2/notes.txt", "keep");
    await seedFile(workspace, "bots/live-bot/notes.txt", "keep");
    await seedFile(workspace, "shared/plan.txt", "keep");
    const { findMany, prisma } = deletedBots("deleted-bot", "never-had-a-folder");

    await removeDeletedBotWorkspaces(
      { prisma, sandbox: localWorkspaceSandbox(workspace) },
      computer,
      "workspace",
      context,
    );

    expect(findMany).toHaveBeenCalledWith({
      where: { spaceId: "workspace" },
      select: { id: true },
    });
    await expect(access(path.join(workspace, "bots", "deleted-bot"))).rejects.toThrow();
    for (const kept of [
      "bots/deleted-bot-2/notes.txt",
      "bots/live-bot/notes.txt",
      "shared/plan.txt",
    ]) {
      await expect(readFile(path.join(workspace, kept), "utf8")).resolves.toBe("keep");
    }
  });

  it("removes deleted bots' browser profiles when a Team Computer wakes", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "rakazo-team-wake-profile-"));
    roots.push(workspace);
    const deletedProfile = `.browser-profiles/${teamBrowserProfileName("deleted-bot")}`;
    const liveProfile = `.browser-profiles/${teamBrowserProfileName("live-bot")}`;
    await seedFile(workspace, `${deletedProfile}/Cookies`, "gone");
    await seedFile(workspace, `${liveProfile}/Cookies`, "keep");
    const { prisma } = deletedBots("deleted-bot");

    await removeDeletedBotWorkspaces(
      { prisma, sandbox: localWorkspaceSandbox(workspace) },
      computer,
      "workspace",
      context,
    );

    await expect(access(path.join(workspace, deletedProfile))).rejects.toThrow();
    await expect(readFile(path.join(workspace, liveProfile, "Cookies"), "utf8")).resolves.toBe(
      "keep",
    );
  });

  it("unlinks a deleted bot's symlink that the provider's file listing does not show", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "rakazo-team-wake-link-"));
    roots.push(workspace);
    await seedFile(workspace, "shared/plan.txt", "keep");
    await mkdir(path.join(workspace, "bots"));
    await symlink("../shared", path.join(workspace, "bots", "deleted-bot"));
    const sandbox = localWorkspaceSandbox(workspace);
    const listFiles = vi.fn().mockResolvedValue([]);
    const { prisma } = deletedBots("deleted-bot");

    await removeDeletedBotWorkspaces(
      { prisma, sandbox: { ...sandbox, listFiles } as unknown as SandboxProvider },
      computer,
      "workspace",
      context,
    );

    expect(listFiles).not.toHaveBeenCalled();
    await expect(lstat(path.join(workspace, "bots", "deleted-bot"))).rejects.toThrow();
    await expect(readFile(path.join(workspace, "shared/plan.txt"), "utf8")).resolves.toBe("keep");
  });

  it("keeps removing deleted bots' folders after one entry is refused", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "rakazo-team-wake-refused-"));
    roots.push(workspace);
    await seedFile(workspace, "bots/deleted-a", "not a folder");
    await seedFile(workspace, "bots/deleted-b/private.txt", "gone");
    const { prisma } = deletedBots("deleted-a", "deleted-b");

    await removeDeletedBotWorkspaces(
      { prisma, sandbox: localWorkspaceSandbox(workspace) },
      computer,
      "workspace",
      context,
    );

    await expect(readFile(path.join(workspace, "bots/deleted-a"), "utf8")).resolves.toBe(
      "not a folder",
    );
    await expect(access(path.join(workspace, "bots", "deleted-b"))).rejects.toThrow();
  });

  it("does not look up deletions when the Team Computer has no bot folders", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "rakazo-team-wake-empty-"));
    roots.push(workspace);
    await mkdir(path.join(workspace, "bots"));
    await mkdir(path.join(workspace, ".browser-profiles"));
    const { findMany, prisma } = deletedBots("deleted-bot");

    await removeDeletedBotWorkspaces(
      { prisma, sandbox: localWorkspaceSandbox(workspace) },
      computer,
      "workspace",
      context,
    );

    expect(findMany).not.toHaveBeenCalled();
  });

  it("reaches the oldest leftover however long the deletion history is", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "rakazo-team-wake-history-"));
    roots.push(workspace);
    await seedFile(workspace, "bots/oldest-bot/private.txt", "gone");
    await seedFile(workspace, "bots/live-bot/notes.txt", "keep");
    const history = Array.from({ length: 5_000 }, (_, index) => `deleted-${index}`);
    const { prisma } = deletedBots(...history, "oldest-bot");
    const sandbox = localWorkspaceSandbox(workspace);
    const execute = vi.spyOn(sandbox, "execute");

    await removeDeletedBotWorkspaces({ prisma, sandbox }, computer, "workspace", context);

    // One listing and one removal, instead of a command per batch of the whole history.
    expect(execute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenLastCalledWith(
      computer,
      { argv: ["bash", "-eu", "-c", expect.any(String), "bash", "bots", "oldest-bot"], cwd: "." },
      expect.anything(),
    );
    await expect(access(path.join(workspace, "bots", "oldest-bot"))).rejects.toThrow();
    await expect(readFile(path.join(workspace, "bots/live-bot/notes.txt"), "utf8")).resolves.toBe(
      "keep",
    );
  });

  it("stops waiting for the cleanup once its time budget runs out", async () => {
    const { prisma } = deletedBots("deleted-bot");
    let commandSignal: AbortSignal | undefined;
    // Never finishes and ignores aborts, like a wedged provider call.
    const execute = vi.fn((_computer: ComputerRef, _request: CommandRequest, commandContext) => {
      commandSignal = (commandContext as typeof context).signal;
      return (async function* () {
        await new Promise(() => undefined);
        yield { type: "exit" as const, code: 0 };
      })();
    });

    await expect(
      removeDeletedBotWorkspaces(
        { prisma, sandbox: { execute } as unknown as SandboxProvider },
        computer,
        "workspace",
        context,
        20,
      ),
    ).rejects.toThrow("team bot folder cleanup ran out of time");
    expect(commandSignal?.aborted).toBe(true);
  });

  it.each([
    ["bots", ".."],
    ["bots", "../shared"],
    ["bots", "."],
    ["shared", "plan"],
  ])("refuses to remove %s/%s", async (parent, name) => {
    const workspace = await mkdtemp(path.join(tmpdir(), "rakazo-team-escape-"));
    roots.push(workspace);
    await seedFile(workspace, "shared/plan/notes.txt", "keep");
    await mkdir(path.join(workspace, "bots"));

    await expect(
      removeComputerWorkspaceDirectories(
        localWorkspaceSandbox(workspace),
        computer,
        parent as "bots",
        [name],
        context,
      ),
    ).rejects.toThrow("folder escapes the team home");
    await expect(readFile(path.join(workspace, "shared/plan/notes.txt"), "utf8")).resolves.toBe(
      "keep",
    );
  });
});

async function seedFile(root: string, relative: string, content: string) {
  const target = path.join(root, relative);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

/** Runs commands in a local folder that stands in for the computer's workspace. */
function localWorkspaceSandbox(workspace: string) {
  return {
    execute: async function* (_computer: ComputerRef, request: CommandRequest) {
      try {
        const stdout = execFileSync(request.argv[0] ?? "bash", request.argv.slice(1), {
          cwd: workspace,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "pipe"],
        });
        if (stdout) yield { type: "stdout" as const, data: stdout };
        yield { type: "exit" as const, code: 0 };
      } catch (error) {
        const failed = error as { status?: number; stderr?: Buffer };
        yield { type: "stderr" as const, data: failed.stderr?.toString() ?? "" };
        yield { type: "exit" as const, code: failed.status ?? 1 };
      }
    },
  } as unknown as SandboxProvider;
}
