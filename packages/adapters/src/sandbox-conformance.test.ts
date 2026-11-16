import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ComputerRef, ProcessEvent, SandboxProvider } from "@rakazo/adapter-kit";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { toComputerRef } from "./computer-support.js";
import {
  fakeBoatProvider as fakeBoat,
  routeFakeBoatDownloads,
} from "./providers/computer/boat/boat-sandbox.test-support.js";
import { fakeBoxdProvider } from "./providers/computer/boxd/boxd-sandbox.test-support.js";
import { emulatedCreateOS } from "./providers/computer/createos/createos-sandbox.test-support.js";
import { emulatedDaytona } from "./providers/computer/daytona/daytona-sandbox.test-support.js";
import { DesktopSandboxProvider } from "./providers/computer/desktop/desktop-sandbox.js";
import { DockerSandboxProvider } from "./providers/computer/docker/docker-sandbox.js";
import { emulatedDockerSupervisor } from "./providers/computer/docker/docker-sandbox.test-support.js";
import { E2BSandboxProvider } from "./providers/computer/e2b/e2b-sandbox.js";
import { FakeSandboxProvider } from "./providers/computer/fake/fake-sandbox.js";
import { emulatedIncus } from "./providers/computer/incus/incus-sandbox.test-support.js";
import { emulatedInstabox } from "./providers/computer/instabox/instabox-sandbox.test-support.js";
import { emulatedKubernetes } from "./providers/computer/kubernetes/kubernetes-sandbox.test-support.js";
import {
  fakeCli,
  removeFakeClis,
} from "./providers/computer/local-vm/apple-container-sandbox.test-support.js";
import {
  emulatedNovita,
  fakeNovita,
} from "./providers/computer/novita/novita-sandbox.test-support.js";
import { emulatedRailway } from "./providers/computer/railway/railway-sandbox.test-support.js";
import { FakeWuyingDesktop } from "./providers/computer/wuying/wuying-sandbox.test-support.js";
import { createSandboxProvider } from "./sandbox-factory.js";
import type { KnownSandboxKind } from "./sandbox-kind-capabilities.js";
import { assertSandboxWorkspaceContract, provisionPrepared } from "./sandbox-test-support.js";

let restoreFetch: () => void;
let supervisor: Awaited<ReturnType<typeof emulatedDockerSupervisor>>;
beforeAll(async () => {
  restoreFetch = routeFakeBoatDownloads();
  supervisor = await emulatedDockerSupervisor();
});
afterAll(async () => {
  restoreFetch();
  await supervisor.close();
});

const ctx = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

async function drain(provider: SandboxProvider, computer: ComputerRef) {
  let stdout = "";
  for await (const event of provider.execute(computer, { argv: ["echo", "graphical-ok"] }, ctx)) {
    if (event.type === "stdout") stdout += event.data;
    if (event.type === "exit") expect(event.code).toBe(0);
  }
  return stdout;
}

/** An offline provider for the shared suite, or what a provider that cannot run computers does. */
type SandboxConformanceFixture =
  | {
      provider(): SandboxProvider;
      /** Files, screen actions and workspace export, beyond the lifecycle every provider runs. */
      workspace: boolean;
      /** Whether its emulated shell can show explicit unsets winning over the request's. */
      unsetEnv: boolean;
    }
  | { refusesComputers: true };

const temporaryRoots: string[] = [];
function temporaryRoot() {
  const root = mkdtempSync(path.join(tmpdir(), "rakazo-conformance-"));
  temporaryRoots.push(root);
  return root;
}

/** Keyed by every provider id, so a provider without an offline fixture fails typecheck. */
const fixtures: Record<KnownSandboxKind, SandboxConformanceFixture> = {
  none: { refusesComputers: true },
  fake: { provider: () => new FakeSandboxProvider(), workspace: true, unsetEnv: true },
  boat: { provider: () => fakeBoat(), workspace: true, unsetEnv: true },
  boxd: { provider: () => fakeBoxdProvider(), workspace: true, unsetEnv: true },
  novita: { provider: () => emulatedNovita().provider(), workspace: true, unsetEnv: true },
  instabox: { provider: () => emulatedInstabox().provider(), workspace: true, unsetEnv: true },
  desktop: {
    provider: () => new DesktopSandboxProvider({ root: temporaryRoot() }),
    workspace: true,
    unsetEnv: true,
  },
  wuying: { provider: () => new FakeWuyingDesktop().provider(), workspace: true, unsetEnv: false },
  e2b: {
    // E2B and Novita share the remote desktop adapter, so one in-memory SDK serves both.
    provider: () => new E2BSandboxProvider("test-e2b-key", fakeNovita().sdk),
    workspace: true,
    unsetEnv: true,
  },
  incus: { provider: () => emulatedIncus().provider, workspace: true, unsetEnv: true },
  kubernetes: { provider: () => emulatedKubernetes().provider, workspace: true, unsetEnv: true },
  createos: { provider: () => emulatedCreateOS().provider, workspace: false, unsetEnv: true },
  docker: {
    provider: () => new DockerSandboxProvider(supervisor.url, "test-supervisor-token"),
    workspace: false,
    unsetEnv: true,
  },
  daytona: { provider: () => emulatedDaytona().provider, workspace: true, unsetEnv: true },
  railway: { provider: () => emulatedRailway().provider, workspace: false, unsetEnv: true },
  "local-vm": { provider: () => fakeCli().provider, workspace: false, unsetEnv: false },
};

const running = Object.entries(fixtures).flatMap(([kind, fixture]) =>
  "refusesComputers" in fixture ? [] : [{ kind, ...fixture }],
);

afterAll(() => {
  removeFakeClis();
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.each(running)("$kind sandbox conformance", (fixture) => {
  it("provisions, runs a command, and treats a repeated destroy as success", async () => {
    const provider = fixture.provider();
    const computer = await provisionPrepared(
      provider,
      { botId: `${fixture.kind}-a`, homePath: `/tmp/${fixture.kind}-a` },
      ctx,
    );
    expect(await drain(provider, computer)).toContain("graphical-ok");
    await provider.destroy(computer, ctx);
    await expect(provider.destroy(computer, ctx)).resolves.toBeUndefined();
  });

  it.runIf(fixture.workspace)(
    "offers the shared observation, action and workspace contract",
    async () => {
      const provider = fixture.provider();
      const computer = await provisionPrepared(
        provider,
        { botId: `${fixture.kind}-portable`, homePath: `/tmp/${fixture.kind}-portable` },
        ctx,
      );
      await assertSandboxWorkspaceContract(provider, computer, ctx);
      await provider.destroy(computer, ctx);
    },
  );

  it.runIf(fixture.unsetEnv)(
    "lets explicit unsets win over inherited and request variables",
    async () => {
      vi.stubEnv("RAKAZO_COMMAND_UNSET_TEST", "fake-host-value");
      try {
        const provider = fixture.provider();
        const computer = await provider.provision(
          { botId: `${fixture.kind}-unset`, homePath: "/unused" },
          ctx,
        );
        const events = [];
        for await (const event of provider.execute(
          computer,
          {
            argv: ["printenv", "RAKAZO_COMMAND_UNSET_TEST"],
            env: { RAKAZO_COMMAND_UNSET_TEST: "fake-request-value" },
            unsetEnv: ["RAKAZO_COMMAND_UNSET_TEST"],
          },
          ctx,
        ))
          events.push(event);
        expect(events).toEqual([{ type: "exit", code: 1 }]);
        await provider.destroy(computer, ctx);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );
});

it("refuses computers on a provider that has none", async () => {
  for (const [kind, fixture] of Object.entries(fixtures)) {
    if (!("refusesComputers" in fixture)) continue;
    const provider = await createSandboxProvider(kind, {});
    await expect(provider.provision({ botId: "b", homePath: "/unused" }, ctx)).rejects.toThrow();
  }
});

describe("desktop sandbox", () => {
  it("desktop executor passes request env to the command", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rakazo-desktop-env-"));
    const desktop = new DesktopSandboxProvider({ root });
    const computer = await desktop.provision({ botId: "env", homePath: "/unused" }, ctx);
    const sentinel = "rakazo-desktop-request-env-sentinel";
    let stdout = "";
    let code = 1;
    for await (const event of desktop.execute(
      computer,
      {
        argv: [
          process.execPath,
          "-e",
          "process.stdout.write(process.env.RAKAZO_DESKTOP_ENV_SENTINEL ?? '')",
        ],
        env: { RAKAZO_DESKTOP_ENV_SENTINEL: sentinel },
      },
      ctx,
    )) {
      if (event.type === "stdout") stdout += event.data;
      if (event.type === "exit") code = event.code;
    }
    expect(code).toBe(0);
    expect(stdout).toContain(sentinel);
    await desktop.destroy(computer, ctx);
    rmSync(root, { recursive: true, force: true });
  });

  it("desktop executor refuses paths outside the computer home", async () => {
    const desktop = new DesktopSandboxProvider();
    const computer = await desktop.provision({ botId: "grant", homePath: "/tmp/grant" }, ctx);
    let stderr = "";
    let code = 0;
    for await (const event of desktop.execute(
      computer,
      { argv: ["echo", "nope"], cwd: "/etc" },
      ctx,
    )) {
      if (event.type === "stderr") stderr += event.data;
      if (event.type === "exit") code = event.code;
    }
    expect(code).toBe(1);
    expect(stderr).toMatch(/outside this computer's home/i);
    await desktop.destroy(computer, ctx);
  });

  it("desktop executor times out and kills descendants that inherited its pipes", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rakazo-desktop-timeout-"));
    const desktop = new DesktopSandboxProvider({ root });
    const computer = await desktop.provision({ botId: "timeout", homePath: "/unused" }, ctx);
    const marker = path.join(computer.providerRef, "descendant-survived");
    const events: ProcessEvent[] = [];
    const startedAt = Date.now();

    for await (const event of desktop.execute(
      computer,
      {
        argv: ["bash", "-lc", "(sleep 0.2; printf survived > descendant-survived) & wait"],
        timeoutMs: 40,
      },
      ctx,
    )) {
      events.push(event);
    }

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(events).toContainEqual({ type: "exit", code: 124 });
    expect(events).toContainEqual({
      type: "stderr",
      data: "command timed out after 40 ms\n",
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(() => readFileSync(marker)).toThrow();

    await desktop.destroy(computer, ctx);
    rmSync(root, { recursive: true, force: true });
  });

  it("desktop executor yields stdout before a command that keeps running exits", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rakazo-desktop-stream-"));
    const desktop = new DesktopSandboxProvider({ root });
    const computer = await desktop.provision({ botId: "stream", homePath: "/unused" }, ctx);
    const controller = new AbortController();
    const startedAt = Date.now();
    const iterator = desktop
      .execute(
        computer,
        {
          argv: [
            "node",
            "-e",
            "process.stdout.write('code: ABCD-1234\\n'); setTimeout(() => {}, 30000)",
          ],
          timeoutMs: 5_000,
        },
        { ...ctx, signal: controller.signal },
      )
      [Symbol.asyncIterator]();

    const first = await iterator.next();
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    expect(first.value).toEqual({ type: "stdout", data: "code: ABCD-1234\n" });
    controller.abort();
    const rest: ProcessEvent[] = [];
    for await (const event of { [Symbol.asyncIterator]: () => iterator }) rest.push(event);
    expect(rest).toContainEqual({ type: "exit", code: 130 });

    await desktop.destroy(computer, ctx);
    rmSync(root, { recursive: true, force: true });
  });

  it("desktop executor aborts and kills a running command", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rakazo-desktop-abort-"));
    const desktop = new DesktopSandboxProvider({ root });
    const computer = await desktop.provision({ botId: "abort", homePath: "/unused" }, ctx);
    const controller = new AbortController();
    const events: ProcessEvent[] = [];
    setTimeout(() => controller.abort(), 25);

    for await (const event of desktop.execute(
      computer,
      { argv: ["bash", "-lc", "sleep 10"], timeoutMs: 5_000 },
      { ...ctx, signal: controller.signal },
    )) {
      events.push(event);
    }

    expect(events).toContainEqual({ type: "exit", code: 130 });
    expect(events).toContainEqual({ type: "stderr", data: "command aborted\n" });

    await desktop.destroy(computer, ctx);
    rmSync(root, { recursive: true, force: true });
  });

  it("reuses one desktop machine per bot", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rakazo-desktop-reuse-"));
    const desktop = new DesktopSandboxProvider({ root });
    const first = await desktop.provision({ botId: "stable", homePath: "/unused" }, ctx);
    const second = await desktop.provision({ botId: "stable", homePath: "/unused" }, ctx);

    expect(first).toMatchObject({ fresh: true });
    expect(second).toMatchObject({ id: first.id, providerRef: first.providerRef, fresh: false });
    expect(desktop.boxes.size).toBe(1);

    await desktop.destroy(second, ctx);
    rmSync(root, { recursive: true, force: true });
  });

  it("reports a desktop machine running through the reference the computer row stores", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rakazo-desktop-running-"));
    const desktop = new DesktopSandboxProvider({ root });
    // The API and the worker each build their own provider over the same data directory.
    const otherProcess = new DesktopSandboxProvider({ root });
    const first = await desktop.provision({ botId: "stable", homePath: "/unused" }, ctx);
    const stored = toComputerRef({
      homeKey: "stable",
      kind: "desktop",
      providerRef: first.providerRef!,
    });
    const never = toComputerRef({
      homeKey: "other",
      kind: "desktop",
      providerRef: path.join(root, "desktop-computers", "other"),
    });

    expect(await desktop.isRunning(stored, ctx)).toBe(true);
    expect(await otherProcess.isRunning(stored, ctx)).toBe(true);
    expect(await otherProcess.isRunning({ ...stored, providerRef: root }, ctx)).toBe(false);
    expect(await desktop.isRunning(never, ctx)).toBe(false);
    await desktop.stop(stored, ctx);
    expect(await desktop.isRunning(stored, ctx)).toBe(false);
    expect(await otherProcess.isRunning(stored, ctx)).toBe(false);
    await otherProcess.provision({ botId: "stable", homePath: "/unused" }, ctx);
    expect(await desktop.isRunning(stored, ctx)).toBe(true);
    rmSync(first.providerRef!, { recursive: true, force: true });
    expect(await otherProcess.isRunning(stored, ctx)).toBe(false);
    writeFileSync(first.providerRef!, "not a home");
    expect(await otherProcess.isRunning(stored, ctx)).toBe(false);
    // A stop it cannot record must fail rather than leave the computer reading as running.
    const blocked = await desktop.provision({ botId: "blocked", homePath: "/unused" }, ctx);
    mkdirSync(`${blocked.providerRef}.stopped`);
    await expect(desktop.stop(blocked, ctx)).rejects.toThrow();
    const gone = { ...never, providerRef: path.join(root, "missing", "gone") };
    await expect(otherProcess.stop(gone, ctx)).resolves.toBeUndefined();
    // A marker that cannot be read is not proof the computer is running.
    const longKey = "k".repeat(250);
    const longHome = path.join(root, "desktop-computers", longKey);
    mkdirSync(longHome);
    await expect(
      otherProcess.isRunning({ ...never, botId: longKey, providerRef: longHome }, ctx),
    ).rejects.toThrow();
    // The marker itself counts, even as a link to nothing.
    const linked = await desktop.provision({ botId: "linked", homePath: "/unused" }, ctx);
    symlinkSync(path.join(root, "nowhere"), `${linked.providerRef}.stopped`);
    const linkedRef = { ...never, botId: "linked", providerRef: linked.providerRef };
    expect(await otherProcess.isRunning(linkedRef, ctx)).toBe(false);
    const kept = await desktop.provision({ botId: "kept", homePath: "/unused" }, ctx);
    await desktop.destroy(kept, ctx);
    expect(
      await otherProcess.isRunning({ ...never, botId: "kept", providerRef: kept.providerRef }, ctx),
    ).toBe(false);

    await desktop.destroy(first, ctx);
    rmSync(root, { recursive: true, force: true });
  });

  it("desktop file writes do not follow a final symlink outside the workspace", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rakazo-desktop-symlink-"));
    const desktop = new DesktopSandboxProvider({ root });
    const computer = await desktop.provision({ botId: "symlink", homePath: "/unused" }, ctx);
    const outside = path.join(root, "outside.txt");
    writeFileSync(outside, "before");
    symlinkSync(outside, path.join(computer.providerRef, "escape.txt"));

    await expect(
      desktop.writeFile(computer, {
        path: "escape.txt",
        content: new TextEncoder().encode("after"),
      }),
    ).rejects.toThrow();
    expect(readFileSync(outside, "utf8")).toBe("before");

    await desktop.destroy(computer, ctx);
    rmSync(root, { recursive: true, force: true });
  });

  it("desktop file listings skip links that dangle or leave the workspace", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "rakazo-desktop-list-links-"));
    const desktop = new DesktopSandboxProvider({ root });
    const computer = await desktop.provision({ botId: "list-links", homePath: "/unused" }, ctx);
    const directory = path.join(computer.providerRef, "links");
    mkdirSync(directory);
    writeFileSync(path.join(root, "outside.txt"), "outside");
    writeFileSync(path.join(directory, "kept.txt"), "inside");
    symlinkSync(path.join(root, "outside.txt"), path.join(directory, "escape.txt"));
    symlinkSync(path.join(directory, "missing.txt"), path.join(directory, "dangling.txt"));

    expect(await desktop.listFiles(computer, "links", ctx)).toEqual([
      { path: "links/kept.txt", kind: "file", size: 6 },
    ]);

    await desktop.destroy(computer, ctx);
    rmSync(root, { recursive: true, force: true });
  });
});
