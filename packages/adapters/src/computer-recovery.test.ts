import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { AdapterContext, JobPublisher, SandboxProvider } from "@rakazo/adapter-kit";
import type { PrismaClient, ThreadEvents } from "@rakazo/db";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComputerBusyError, provisionComputer, replaceComputer } from "./computer-lifecycle.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { LocalAgentHomeStore } from "./home.js";

const context = {
  operationId: "recovery",
  traceId: "recovery",
  spaceId: "space",
  userId: "user",
  botId: "bot",
  signal: new AbortController().signal,
} satisfies AdapterContext;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(provider: "fake" | "desktop" = "fake") {
  const root = await mkdtemp(path.join(tmpdir(), "rakazo-recovery-"));
  roots.push(root);
  const sandbox: SandboxProvider =
    provider === "desktop" ? new DesktopSandboxProvider({ root }) : new FakeSandboxProvider();
  const home = new LocalAgentHomeStore(path.join(root, "homes"));
  const first = await sandbox.provision({ botId: "bot", homePath: root }, context);
  await home.writeFile("bot", "notes.txt", "checkpoint", context);
  await sandbox.writeFile(
    first,
    { path: "notes.txt", content: new TextEncoder().encode("live work") },
    context,
  );
  const row = {
    id: "computer",
    homeKey: "bot",
    scope: "dedicated",
    state: "running",
    providerRef: first.providerRef as string | null,
    kind: first.kind,
    controlHolder: "none",
    controlLeaseId: null,
    homeRevision: "saved",
  };
  // Model the atomic scalar predicates used by claims, including stale references.
  const computer = {
    findUniqueOrThrow: vi.fn(async () => ({ ...row })),
    updateMany: vi.fn(async ({ where, data }) => {
      const matches = ["id", "state", "providerRef", "kind"].every(
        (key) => !(key in where) || where[key] === row[key as keyof typeof row],
      );
      if (!matches) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    }),
    update: vi.fn(async ({ data }) => Object.assign(row, data)),
  };
  const deps = {
    prisma: {
      computer,
      run: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient,
    sandbox,
    home,
    jobs: {} as JobPublisher,
    events: {} as ThreadEvents,
    dataDir: root,
  };
  return { deps, row, computer, first, root };
}

describe("computer recovery preserves live work", () => {
  it("claims a running computer before concurrent workers can create competing replacements", async () => {
    const { deps, row, computer, first } = await fixture();
    await deps.sandbox.destroy(first, context);
    row.providerRef = "missing-provider";
    // Both workers read the original row before either claims it.
    const original = { ...row };
    computer.findUniqueOrThrow.mockResolvedValue(original);
    const provision = vi.spyOn(deps.sandbox, "provision");
    const restore = vi.spyOn(deps.sandbox, "importWorkspace");
    const results = await Promise.allSettled([
      provisionComputer(deps, row.id, context),
      provisionComputer(deps, row.id, { ...context, botId: "other-bot" }),
    ]);
    const successful = results.filter((result) => result.status === "fulfilled");
    const rejected = results.filter((result) => result.status === "rejected");
    expect(successful).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(ComputerBusyError);
    expect(provision).toHaveBeenCalledOnce();
    expect(restore).toHaveBeenCalledOnce();
    expect(row.providerRef).toBe(successful[0]?.value.providerRef);
    expect(row.state).toBe("running");
  });

  it("rejects a delayed reconnect whose original reference was already replaced", async () => {
    const { deps, row, computer, first } = await fixture();
    await deps.sandbox.destroy(first, context);
    row.providerRef = "missing-provider";
    const stale = { ...row };
    const winner = await provisionComputer(deps, row.id, context);
    await deps.sandbox.writeFile(
      winner,
      { path: "notes.txt", content: new TextEncoder().encode("winner work") },
      context,
    );
    computer.findUniqueOrThrow.mockResolvedValue(stale);
    const provision = vi.spyOn(deps.sandbox, "provision");
    await expect(provisionComputer(deps, row.id, context)).rejects.toBeInstanceOf(
      ComputerBusyError,
    );
    expect(provision).not.toHaveBeenCalled();
    expect(row.providerRef).toBe(winner.providerRef);
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(winner, "notes.txt", context)),
    ).toBe("winner work");
  });

  it("preserves the reference and workspace through an uncertain reconnect and a retry", async () => {
    const { deps, row, first } = await fixture();
    const error = new Error("fetch failed");
    vi.spyOn(deps.sandbox, "provision").mockRejectedValueOnce(error);
    const restore = vi.spyOn(deps.sandbox, "importWorkspace");
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    await expect(provisionComputer(deps, row.id, context)).rejects.toBe(error);
    expect(row).toMatchObject({ state: "running", providerRef: first.providerRef });
    const reconnected = await provisionComputer(deps, row.id, context);
    expect(reconnected).toMatchObject({ providerRef: first.providerRef, fresh: false });
    expect(restore).not.toHaveBeenCalled();
    expect(destroy).not.toHaveBeenCalled();
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(reconnected, "notes.txt", context)),
    ).toBe("live work");
  });

  it.each(["running", "error", "stopped", "suspended"])(
    "reconnects desktop files after an adapter restart from %s without importing an old checkpoint",
    async (state) => {
      const { deps, row, root, first } = await fixture("desktop");
      row.state = state;
      deps.sandbox = new DesktopSandboxProvider({ root });
      const restore = vi.spyOn(deps.sandbox, "importWorkspace");
      const reconnected = await provisionComputer(deps, row.id, context);
      expect(reconnected).toMatchObject({ providerRef: first.providerRef, fresh: false });
      expect(restore).not.toHaveBeenCalled();
      expect(
        new TextDecoder().decode(await deps.sandbox.readFile(reconnected, "notes.txt", context)),
      ).toBe("live work");
    },
  );

  it("restores the checkpoint when a desktop workspace is actually absent after restart", async () => {
    const { deps, row, root, first } = await fixture("desktop");
    expect(first.fresh).toBe(true);
    await rm(first.providerRef, { recursive: true });
    deps.sandbox = new DesktopSandboxProvider({ root });
    const reconnected = await provisionComputer(deps, row.id, context);
    expect(reconnected).toMatchObject({ providerRef: first.providerRef, fresh: true });
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(reconnected, "notes.txt", context)),
    ).toBe("checkpoint");
  });

  it.each([
    "Path notes.txt not found",
    "404: file not found",
    "command not found",
    "checkpoint directory does not exist",
    "export process killed",
    "ECONNRESET",
    "Sandbox not found",
  ])("aborts update and its retry when checkpoint fails with %s", async (message) => {
    const { deps, row, first } = await fixture();
    const error = new Error(message);
    vi.spyOn(deps.sandbox, "exportWorkspace").mockImplementation(async function* () {
      yield { path: "notes.txt", content: new TextEncoder().encode("incomplete checkpoint") };
      throw error;
    });
    const destroy = vi.spyOn(deps.sandbox, "destroy");
    const provision = vi.spyOn(deps.sandbox, "provision");
    for (let attempt = 0; attempt < 2; attempt++) {
      await expect(replaceComputer(deps, row.id, "update", context)).rejects.toBe(error);
      expect(row).toMatchObject({
        state: "error",
        providerRef: first.providerRef,
        homeRevision: "saved",
      });
    }
    expect(destroy).not.toHaveBeenCalled();
    expect(provision).not.toHaveBeenCalled();
    expect(new TextDecoder().decode(await deps.sandbox.readFile(first, "notes.txt", context))).toBe(
      "live work",
    );
    expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("checkpoint");
  });

  it.each(["running", "error"])(
    "updates a %s computer only after saving its current workspace",
    async (state) => {
      const { deps, row } = await fixture();
      row.state = state;
      const updated = await replaceComputer(deps, row.id, "update", context);
      expect(updated.fresh).toBe(true);
      expect(row).toMatchObject({ state: "running", providerRef: updated.providerRef });
      expect(
        new TextDecoder().decode(await deps.sandbox.readFile(updated, "notes.txt", context)),
      ).toBe("live work");
      expect(await deps.home.readFile("bot", "notes.txt", context)).toBe("live work");
    },
  );

  it("resets a missing computer after idempotent provider teardown", async () => {
    const { deps, row, first } = await fixture();
    await deps.sandbox.destroy(first, context);
    const updated = await replaceComputer(deps, row.id, "reset", context);
    expect(updated.fresh).toBe(true);
    expect(row).toMatchObject({ state: "running", providerRef: updated.providerRef });
    expect(
      new TextDecoder().decode(await deps.sandbox.readFile(updated, "notes.txt", context)),
    ).toBe("checkpoint");
  });

  it("preserves the reference when reset teardown fails ambiguously", async () => {
    const { deps, row, first } = await fixture();
    const failure = new Error("404: configuration file not found");
    vi.spyOn(deps.sandbox, "destroy").mockRejectedValue(failure);
    const provision = vi.spyOn(deps.sandbox, "provision");
    await expect(replaceComputer(deps, row.id, "reset", context)).rejects.toBe(failure);
    expect(provision).not.toHaveBeenCalled();
    expect(row.providerRef).toBe(first.providerRef);
  });
});
