import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  checkpointComputerWorkspace,
  ensureComputerWorkspaceLayout,
  restoreComputerWorkspace,
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
