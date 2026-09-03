import { execSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ComputerRef, ProcessEvent, SandboxProvider } from "@rakazo/adapter-kit";
import { afterAll, describe, expect, it } from "vitest";
import { BoxSandboxEmulator } from "./box-emulator.js";
import { DaytonaSandboxEmulator } from "./daytona-emulator.js";
import { DesktopSandboxProvider } from "./desktop-sandbox.js";
import { DockerSandboxProvider } from "./docker-sandbox.js";
import { ManagedSandboxEmulator } from "./e2b-emulator.js";
import { FakeSandboxProvider } from "./fake-sandbox.js";
import { provisionPrepared } from "./sandbox-test-support.js";

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

describe("sandbox conformance", () => {
  it("runs the same graphical command across fake, managed-provider emulators, and desktop", async () => {
    const fake = new FakeSandboxProvider();
    const managed = new ManagedSandboxEmulator();
    const daytona = new DaytonaSandboxEmulator();
    const box = new BoxSandboxEmulator();
    const desktop = new DesktopSandboxProvider();
    const a = await provisionPrepared(fake, { botId: "bot-a", homePath: "/tmp/a" }, ctx);
    const b = await provisionPrepared(managed, { botId: "bot-b", homePath: "/tmp/b" }, ctx);
    const c = await provisionPrepared(daytona, { botId: "bot-c", homePath: "/tmp/c" }, ctx);
    const d = await provisionPrepared(box, { botId: "bot-d", homePath: "/tmp/d" }, ctx);
    const e = await provisionPrepared(desktop, { botId: "bot-e", homePath: "/tmp/e" }, ctx);
    const outA = await drain(fake, a);
    const outB = await drain(managed, b);
    const outC = await drain(daytona, c);
    const outD = await drain(box, d);
    const outE = await drain(desktop, e);
    expect(outA).toContain("graphical-ok");
    expect(outB).toContain("graphical-ok");
    expect(outC).toContain("graphical-ok");
    expect(outD).toContain("graphical-ok");
    expect(outE).toContain("graphical-ok");
    expect(new Set([a.id, b.id, c.id, d.id, e.id]).size).toBe(5);
    await fake.destroy(a, ctx);
    await managed.destroy(b, ctx);
    await daytona.destroy(c, ctx);
    await box.destroy(d, ctx);
    await desktop.destroy(e, ctx);
  });

  it("offers the same observation, action, and workspace contract across providers", async () => {
    const providers: SandboxProvider[] = [
      new FakeSandboxProvider(),
      new ManagedSandboxEmulator(),
      new DaytonaSandboxEmulator(),
      new BoxSandboxEmulator(),
      new DesktopSandboxProvider(),
    ];
    for (const [index, provider] of providers.entries()) {
      const computer = await provisionPrepared(
        provider,
        { botId: `portable-${index}`, homePath: `/tmp/portable-${index}` },
        ctx,
      );
      await provider.prepare(computer, ctx);
      await provider.writeFile(
        computer,
        { path: "notes/result.txt", content: new TextEncoder().encode("portable") },
        ctx,
      );
      expect(await provider.listFiles(computer, "notes", ctx)).toEqual([
        { path: "notes/result.txt", kind: "file", size: 8 },
      ]);
      expect(
        new TextDecoder().decode(await provider.readFile(computer, "notes/result.txt", ctx)),
      ).toBe("portable");
      const binary = Uint8Array.from([0, 255, 1, 128]);
      await provider.writeFile(
        computer,
        { path: "bin/tool", content: binary, executable: true },
        ctx,
      );
      expect(await provider.readFile(computer, "bin/tool", ctx)).toEqual(binary);
      expect(await provider.listFiles(computer, "bin", ctx)).toEqual([
        { path: "bin/tool", kind: "file", size: 4, executable: true },
      ]);
      const acted = await provider.act(
        computer,
        { actions: [{ kind: "clipboard", text: "visible" }], observe: true },
        ctx,
      );
      expect(acted.completed).toBe(1);
      expect(acted.observation?.image.byteLength).toBeGreaterThan(0);
      const exported = [];
      for await (const file of provider.exportWorkspace(computer, ctx)) exported.push(file);
      expect(exported.map((file) => file.path)).toContain("notes/result.txt");
      expect(exported.find((file) => file.path === "bin/tool")).toMatchObject({
        content: binary,
        executable: true,
      });
      await provider.destroy(computer, ctx);
    }
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
});

describe("docker sandbox", () => {
  let spawned: ReturnType<typeof spawn> | undefined;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-docker-conformance-"));

  afterAll(async () => {
    spawned?.kill("SIGTERM");
    rmSync(dataDir, { recursive: true, force: true });
  });

  it("runs the same graphical command through the supervisor", async ({ skip }) => {
    if (!dockerAvailable() || !hasAnySandboxImage()) {
      skip();
      return;
    }
    const port = 17991;
    const token = "sandbox-conformance-token";
    const url = `http://127.0.0.1:${port}`;
    const root = path.resolve(import.meta.dirname, "../../..");
    spawned = spawn("pnpm", ["--filter", "@rakazo/sandbox-supervisor", "start"], {
      cwd: root,
      env: {
        ...process.env,
        DATA_DIR: dataDir,
        SANDBOX_SUPERVISOR_TOKEN: token,
        SUPERVISOR_PORT: String(port),
      },
      stdio: "ignore",
    });
    const up = await waitForHealth(`${url}/health`, 20_000);
    if (!up) {
      skip();
      return;
    }
    const provider = new DockerSandboxProvider(url, token);
    const botId = `conf-${Date.now()}`;
    const computer = await provider.provision(
      { botId, homePath: path.join(dataDir, "homes", botId) },
      ctx,
    );
    const out = await drain(provider, computer);
    expect(out).toContain("graphical-ok");
    const session = await provider.connectScreen(computer, { view: "stream" }, ctx);
    expect(session.url).toMatch(/embed\.html/);
    await provider.destroy(computer, ctx);
  }, 60_000);
});

function dockerAvailable() {
  try {
    execSync("docker info", { stdio: "ignore", timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

function hasAnySandboxImage() {
  try {
    execSync("docker image inspect rakazo/computer:local", { stdio: "ignore", timeout: 8_000 });
    return true;
  } catch {
    return false;
  }
}

async function ping(url: string) {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

async function waitForHealth(url: string, ms: number) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (await ping(url)) return true;
    await new Promise((r) => setTimeout(r, 300));
  }
  return false;
}
