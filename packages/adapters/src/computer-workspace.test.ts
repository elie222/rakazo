import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cachedWorkspaceSnapshot,
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
  it.each(["snapshot", "cache-write"])("keeps the durable home when %s fails", async (failure) => {
    const root = await mkdtemp(path.join(tmpdir(), "workspace-cache-"));
    roots.push(root);
    const home = Object.assign(new LocalAgentHomeStore(root), {
      saveWorkspaceSnapshot: vi.fn(async () => {
        if (failure === "cache-write") throw new Error("cache unavailable");
      }),
    });
    const provider = Object.assign(new FakeSandboxProvider(), {
      snapshotWorkspace: vi.fn(async () => {
        if (failure === "snapshot") throw new Error("provider unavailable");
        return "snapshot";
      }),
    });
    const first = await provider.provision({ botId: "bot", homePath: "/ignored" }, context);
    await provider.writeFile(
      first,
      { path: "saved.txt", content: Buffer.from("durable") },
      context,
    );
    await checkpointComputerWorkspace(home, provider, "bot", first, context);
    const replacementProvider = new FakeSandboxProvider();
    const replacement = await replacementProvider.provision(
      { botId: "bot", homePath: "/ignored" },
      context,
    );
    await restoreComputerWorkspace(home, replacementProvider, "bot", replacement, context);
    expect(
      Buffer.from(await replacementProvider.readFile(replacement, "saved.txt", context)).toString(),
    ).toBe("durable");
  });

  it("does not overwrite a natively restored home and tolerates cache lookup failure", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "workspace-cache-"));
    roots.push(root);
    const home = Object.assign(new LocalAgentHomeStore(root), {
      getWorkspaceSnapshot: vi.fn(async () => {
        throw new Error("cache unavailable");
      }),
    });
    const provider = Object.assign(new FakeSandboxProvider(), {
      snapshotWorkspace: async () => "snapshot",
    });
    const computer = await provider.provision({ botId: "bot", homePath: "/ignored" }, context);
    await provider.writeFile(
      computer,
      { path: "saved.txt", content: Buffer.from("native") },
      context,
    );
    await restoreComputerWorkspace(
      home,
      provider,
      "bot",
      { ...computer, workspaceRestored: true },
      context,
    );
    expect(Buffer.from(await provider.readFile(computer, "saved.txt", context)).toString()).toBe(
      "native",
    );
    await expect(cachedWorkspaceSnapshot(home, provider, "bot", context)).resolves.toBeUndefined();
  });
});
