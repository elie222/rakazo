import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ComputerRef, ProcessEvent } from "@rakazo/adapter-kit";
import { Sandbox, SandboxFileNotFoundError, SandboxNotFoundError } from "railway";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WebSocket from "ws";
import { LinuxDesktop } from "./linux-desktop.js";
import { RailwaySandboxProvider } from "./railway-sandbox.js";
import { assertSandboxWorkspaceContract } from "./sandbox-test-support.js";

vi.mock("railway", () => ({
  Sandbox: { create: vi.fn(), connect: vi.fn() },
  SandboxNotFoundError: class extends Error {},
  SandboxFileNotFoundError: class extends Error {},
}));

const ctx = {
  operationId: "op",
  traceId: "trace",
  spaceId: "space",
  userId: "user",
  signal: new AbortController().signal,
};
const computer: ComputerRef = {
  id: "sandbox",
  providerRef: "sandbox",
  kind: "railway",
  botId: "bot",
};
const provider = new RailwaySandboxProvider({ token: "test", environmentId: "environment" });
const sandbox = {
  id: "sandbox",
  domains: [{ port: 6080, domain: "screen.example.test" }],
  status: "RUNNING",
  destroy: vi.fn(),
  heartbeat: vi.fn(),
  exec: vi.fn(),
  files: { read: vi.fn(), write: vi.fn(), list: vi.fn() },
};

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(Sandbox.connect).mockResolvedValue(sandbox as unknown as Sandbox);
  vi.mocked(Sandbox.create).mockResolvedValue(sandbox as unknown as Sandbox);
  sandbox.exec.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
});

describe("Railway computers", () => {
  it("closes a rejected SDK WebSocket handshake without re-entering its error handler", async () => {
    await provider.provision({ botId: "bot", homePath: "/unused" }, ctx);
    const Socket = vi.mocked(Sandbox.create).mock.calls[0]?.[0]?.webSocketImpl;
    if (!Socket) throw new Error("Railway WebSocket transport is missing");
    const server = createServer((_request, response) => response.writeHead(403).end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Server did not bind");
      const socket = new Socket(`ws://127.0.0.1:${address.port}`);
      if (!(socket instanceof WebSocket)) throw new Error("Unexpected WebSocket transport");
      const onError = vi.fn(() => socket.close(1000, ""));
      socket.onerror = onError;
      await new Promise<void>((resolve) => {
        socket.onclose = () => resolve();
      });
      expect(onError).toHaveBeenCalledOnce();
      expect(socket.readyState).toBe(WebSocket.CLOSED);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("satisfies the shared workspace contract through the Railway SDK", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rakazo-railway-contract-"));
    const localPath = (filePath: string) => filePath.replace("/home/rakazo", directory);
    sandbox.files.write.mockImplementation(
      async (filePath: string, content: Uint8Array, options?: { mode: number }) => {
        await mkdir(path.dirname(localPath(filePath)), { recursive: true });
        await writeFile(localPath(filePath), content, options);
      },
    );
    sandbox.files.read.mockImplementation(
      async (filePath: string) => new Uint8Array(await readFile(localPath(filePath))),
    );
    sandbox.files.list.mockImplementation(async (filePath: string) =>
      Promise.all(
        (await readdir(localPath(filePath))).map(async (name) => {
          const entry = await stat(path.join(localPath(filePath), name));
          return { name, isDir: entry.isDirectory(), size: entry.size, mode: entry.mode };
        }),
      ),
    );
    sandbox.exec.mockImplementation(async (command: string) => {
      if (
        command.includes("find . -type f -print0") ||
        command.startsWith("'echo'") ||
        command.startsWith("chmod ")
      ) {
        const result = await promisify(execFile)("bash", [
          "-c",
          command.replaceAll("/home/rakazo", directory),
        ]);
        return { ...result, exitCode: 0 };
      }
      return {
        exitCode: 0,
        stdout: command.includes("RAKAZO_DESKTOP=")
          ? "RAKAZO_DESKTOP=0:test-token"
          : command.includes("CURSOR")
            ? "aW1hZ2U=\nCURSOR X=1 Y=2"
            : "",
      };
    });
    try {
      await assertSandboxWorkspaceContract(provider, computer, ctx);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("reuses an existing computer without marking its workspace fresh", async () => {
    expect(
      await provider.provision(
        { botId: "bot", homePath: "/unused", providerRef: "sandbox", providerKind: "railway" },
        ctx,
      ),
    ).toMatchObject({ providerRef: "sandbox", fresh: false });
    expect(Sandbox.create).not.toHaveBeenCalled();
  });

  it("replaces a missing computer and requests portable home restoration", async () => {
    vi.mocked(Sandbox.connect).mockRejectedValue(
      new SandboxNotFoundError({ id: "missing", environmentId: "environment" }),
    );
    expect(
      await provider.provision(
        { botId: "bot", homePath: "/unused", providerRef: "missing", providerKind: "railway" },
        ctx,
      ),
    ).toMatchObject({ fresh: true, kind: "railway" });
    expect(Sandbox.create).toHaveBeenCalledWith(
      expect.objectContaining({ environmentId: "environment", domains: [{ port: 6080 }] }),
    );
  });

  it.each(["DESTROYED", "DESTROYING", "FAILED"])("replaces a %s computer", async (status) => {
    vi.mocked(Sandbox.connect).mockResolvedValue({ ...sandbox, status } as unknown as Sandbox);
    expect(
      await provider.provision(
        { botId: "bot", homePath: "/unused", providerRef: "old", providerKind: "railway" },
        ctx,
      ),
    ).toMatchObject({ fresh: true });
    expect(Sandbox.create).toHaveBeenCalledOnce();
  });

  it("does not replace a computer on authentication or network errors", async () => {
    vi.mocked(Sandbox.connect).mockRejectedValue(new Error("unauthorized"));
    await expect(
      provider.provision(
        { botId: "bot", homePath: "/unused", providerRef: "sandbox", providerKind: "railway" },
        ctx,
      ),
    ).rejects.toThrow("unauthorized");
    expect(Sandbox.create).not.toHaveBeenCalled();
  });

  it("destroys a new computer if its caller cancels during creation", async () => {
    const controller = new AbortController();
    vi.mocked(Sandbox.create).mockImplementation(async () => {
      controller.abort();
      return sandbox as unknown as Sandbox;
    });
    await expect(
      provider.provision(
        { botId: "bot", homePath: "/unused" },
        { ...ctx, signal: controller.signal },
      ),
    ).rejects.toThrow();
    expect(sandbox.destroy).toHaveBeenCalledOnce();
  });

  it("preserves output and reports timeout as a nonzero exit", async () => {
    sandbox.exec.mockResolvedValue({
      stdout: "partial",
      stderr: "timeout",
      exitCode: null,
      timedOut: true,
    });
    const events: ProcessEvent[] = [];
    for await (const event of provider.execute(
      computer,
      { argv: ["echo", "a; touch /tmp/unwanted"], cwd: "notes", timeoutMs: 5000 },
      ctx,
    ))
      events.push(event);
    expect(events).toEqual([
      { type: "stdout", data: "partial" },
      { type: "stderr", data: "timeout" },
      { type: "exit", code: 124 },
    ]);
    expect(sandbox.exec).toHaveBeenCalledWith(
      expect.stringContaining("'a; touch /tmp/unwanted'"),
      expect.objectContaining({ cwd: "/home/rakazo/notes", timeoutSec: 5 }),
    );
  });

  it("protects screen sockets with a per-screen token", async () => {
    sandbox.exec.mockResolvedValue({
      stdout: "RAKAZO_DESKTOP=0:screen-token",
      stderr: "",
      exitCode: 0,
      timedOut: false,
    });
    const screen = await provider.connectScreen(
      computer,
      { view: "stream", interactive: false },
      ctx,
    );
    if (!screen.url) throw new Error("missing screen URL");
    const url = new URL(screen.url);
    expect(url.origin).toBe("https://screen.example.test");
    expect(url.searchParams.get("path")).toBe("websockify?token=screen-token");
    expect(url.searchParams.has("token")).toBe(false);
  });

  it("rejects oversized files instead of returning truncated content", async () => {
    sandbox.files.read.mockResolvedValue(new Uint8Array(4));
    await expect(provider.readFile(computer, "file", ctx, { maxBytes: 3 })).rejects.toThrow(
      "exceeds 3 bytes",
    );
  });

  it("keeps binary data and executable permissions on writes", async () => {
    const content = Uint8Array.from([0, 255, 128]);
    await provider.writeFile(computer, { path: "bin/tool", content, executable: true }, ctx);
    expect(sandbox.files.write).toHaveBeenCalledWith("/home/rakazo/bin/tool", content, {
      mode: 0o700,
    });
  });

  it("rejects paths outside the workspace", async () => {
    await expect(provider.readFile(computer, "../../secret", ctx)).rejects.toThrow();
    expect(sandbox.files.read).not.toHaveBeenCalled();
  });

  it("exports regular binary files without following links or reading FIFOs", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "rakazo-railway-"));
    const stopBrowsers = vi.spyOn(LinuxDesktop.prototype, "stopBrowsers").mockResolvedValue();
    try {
      await mkdir(path.join(directory, "bin"));
      const content = Uint8Array.from([0, 255, 128]);
      await writeFile(path.join(directory, "bin/tool"), content, { mode: 0o700 });
      await writeFile(path.join(directory, "note"), "saved", { mode: 0o600 });
      await symlink("bin", path.join(directory, "linked-bin"));
      await promisify(execFile)("mkfifo", [path.join(directory, "pipe")]);
      sandbox.exec.mockImplementation(async (command: string) => {
        const result = await promisify(execFile)("bash", [
          "-c",
          command.replaceAll("/home/rakazo", directory),
        ]);
        return { ...result, exitCode: 0, timedOut: false };
      });
      sandbox.files.read.mockImplementation(
        async (filePath: string) =>
          new Uint8Array(await readFile(filePath.replace("/home/rakazo", directory))),
      );
      const exported = [];
      for await (const file of provider.exportWorkspace(computer, ctx)) exported.push(file);
      expect(exported).toEqual(
        expect.arrayContaining([
          { path: "bin/tool", content, executable: true },
          { path: "note", content: new TextEncoder().encode("saved"), executable: false },
        ]),
      );
      expect(exported).toHaveLength(2);
      expect(Sandbox.connect).toHaveBeenCalledTimes(2);
    } finally {
      stopBrowsers.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("restores binary files and permissions over one connection", async () => {
    const stopBrowsers = vi.spyOn(LinuxDesktop.prototype, "stopBrowsers").mockResolvedValue();
    const content = Uint8Array.from([0, 255, 128]);
    try {
      async function* files() {
        yield { path: "bin/tool", content, executable: true };
        yield { path: "note", content, executable: false };
      }
      await provider.importWorkspace(computer, files(), ctx);
      expect(Sandbox.connect).toHaveBeenCalledTimes(1);
      expect(sandbox.exec).toHaveBeenNthCalledWith(
        1,
        "chmod 700 -- '/home/rakazo'",
        expect.objectContaining({ signal: ctx.signal }),
      );
      const protectOrder = sandbox.exec.mock.invocationCallOrder[0];
      const writeOrder = sandbox.files.write.mock.invocationCallOrder[0];
      if (protectOrder === undefined || writeOrder === undefined)
        throw new Error("Missing restore operations");
      expect(protectOrder).toBeLessThan(writeOrder);
      expect(sandbox.files.write).toHaveBeenCalledWith("/home/rakazo/bin/tool", content);
      expect(sandbox.files.write).toHaveBeenCalledWith("/home/rakazo/note", content);
      expect(sandbox.exec).toHaveBeenCalledWith(
        "chmod 700 -- '/home/rakazo/bin/tool'",
        expect.objectContaining({ signal: ctx.signal }),
      );
      expect(sandbox.exec).toHaveBeenCalledWith(
        "chmod 600 -- '/home/rakazo/note'",
        expect.objectContaining({ signal: ctx.signal }),
      );
    } finally {
      stopBrowsers.mockRestore();
    }
  });

  it("restores many files without one exec connection per file", async () => {
    const stopBrowsers = vi.spyOn(LinuxDesktop.prototype, "stopBrowsers").mockResolvedValue();
    let active = 0;
    let peak = 0;
    sandbox.files.write.mockImplementation(async () => {
      peak = Math.max(peak, ++active);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      active--;
    });
    async function* files() {
      for (let index = 0; index < 130; index++)
        yield { path: `file-${index}`, content: Uint8Array.of(index) };
    }
    try {
      await provider.importWorkspace(computer, files(), ctx);
      expect(sandbox.files.write).toHaveBeenCalledTimes(130);
      expect(peak).toBe(4);
      expect(sandbox.exec).toHaveBeenCalledTimes(4);
      expect(sandbox.files.write.mock.calls.every((call) => call[2] === undefined)).toBe(true);
      sandbox.files.write.mockClear();
      sandbox.exec.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "denied" });
      await expect(provider.importWorkspace(computer, files(), ctx)).rejects.toThrow("permissions");
      expect(sandbox.files.write).not.toHaveBeenCalled();
    } finally {
      stopBrowsers.mockRestore();
    }
  });

  it("rejects oversized exports before reading and files that grow during a read", async () => {
    const stopBrowsers = vi.spyOn(LinuxDesktop.prototype, "stopBrowsers").mockResolvedValue();
    const bounded = new RailwaySandboxProvider({
      token: "test",
      environmentId: "environment",
      maxWorkspaceFileBytes: "4",
    });
    try {
      sandbox.exec.mockResolvedValue({ exitCode: 0, stdout: "large\u0000600\u00005\u0000" });
      await expect(bounded.exportWorkspace(computer, ctx).next()).rejects.toThrow(
        "exceeds 4 bytes",
      );
      expect(sandbox.files.read).not.toHaveBeenCalled();
      sandbox.exec.mockResolvedValue({ exitCode: 0, stdout: "growing\u0000600\u00004\u0000" });
      sandbox.files.read.mockResolvedValue(new Uint8Array(5));
      await expect(bounded.exportWorkspace(computer, ctx).next()).rejects.toThrow(
        "exceeds 4 bytes",
      );
      expect(sandbox.files.read).toHaveBeenCalledWith("/home/rakazo/growing", {
        format: "bytes",
        length: 5,
      });
    } finally {
      stopBrowsers.mockRestore();
    }
  });

  it("retries growing files separately within the read budget", async () => {
    const stopBrowsers = vi.spyOn(LinuxDesktop.prototype, "stopBrowsers").mockResolvedValue();
    const bounded = new RailwaySandboxProvider({
      token: "test",
      environmentId: "environment",
      maxWorkspaceFileBytes: "8",
    });
    sandbox.exec.mockResolvedValue({
      exitCode: 0,
      stdout: [0, 1, 2, 3].map((index) => `file-${index}\0${600}\0${2}\0`).join(""),
    });
    let reserved = 0;
    let peak = 0;
    sandbox.files.read.mockImplementation(async (_path, options) => {
      reserved += options.length;
      peak = Math.max(peak, reserved);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      reserved -= options.length;
      return new Uint8Array(Math.min(8, options.length));
    });
    try {
      const files = [];
      for await (const file of bounded.exportWorkspace(computer, ctx)) files.push(file);
      expect(files).toHaveLength(4);
      expect(files.map((file) => file.content.byteLength)).toEqual([8, 8, 8, 8]);
      expect(peak).toBe(12);
      expect(sandbox.files.read).toHaveBeenCalledTimes(8);
    } finally {
      stopBrowsers.mockRestore();
    }
  });

  it.each(["0", "-1", "1.5", "invalid"])("rejects an invalid export limit %s", (limit) => {
    expect(
      () =>
        new RailwaySandboxProvider({
          token: "test",
          environmentId: "environment",
          maxWorkspaceFileBytes: limit,
        }),
    ).toThrow();
  });

  it("allows repeated destroy calls for an absent computer", async () => {
    vi.mocked(Sandbox.connect).mockRejectedValue(
      new SandboxNotFoundError({ id: "missing", environmentId: "environment" }),
    );
    await expect(provider.destroy(computer, ctx)).resolves.toBeUndefined();
    expect(await provider.isRunning(computer, ctx)).toBe(false);
  });

  it("bounds concurrent restore memory while copying every file", async () => {
    const stopBrowsers = vi.spyOn(LinuxDesktop.prototype, "stopBrowsers").mockResolvedValue();
    const content = new Uint8Array(3 * 1024 * 1024);
    let activeBytes = 0;
    let peakBytes = 0;
    sandbox.files.write.mockImplementation(async (_path: string, bytes: Uint8Array) => {
      activeBytes += bytes.byteLength;
      peakBytes = Math.max(peakBytes, activeBytes);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      activeBytes -= bytes.byteLength;
    });
    try {
      async function* files() {
        for (let index = 0; index < 20; index++) yield { path: `file-${index}`, content };
      }
      await provider.importWorkspace(computer, files(), ctx);
      expect(sandbox.files.write).toHaveBeenCalledTimes(20);
      expect(peakBytes).toBeGreaterThan(content.byteLength);
      expect(peakBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
    } finally {
      stopBrowsers.mockRestore();
    }
  });

  it("exports oversized files alone and limits the bytes read together", async () => {
    const stopBrowsers = vi.spyOn(LinuxDesktop.prototype, "stopBrowsers").mockResolvedValue();
    const sizes = [3, 3, 3, 12, 3, 3].map((size) => size * 1024 * 1024);
    sandbox.exec.mockResolvedValue({
      exitCode: 0,
      stdout: sizes.map((size, index) => `file-${index}\0${600}\0${size}\0`).join(""),
    });
    let activeBytes = 0;
    let peakBytes = 0;
    sandbox.files.read.mockImplementation(async (filePath: string) => {
      const size = sizes[Number(filePath.split("-").at(-1))];
      if (size === undefined) throw new Error("Unexpected file");
      activeBytes += size;
      expect(activeBytes).toBeLessThanOrEqual(Math.max(size, 8 * 1024 * 1024));
      peakBytes = Math.max(peakBytes, activeBytes);
      await new Promise<void>((resolve) => queueMicrotask(resolve));
      activeBytes -= size;
      return new Uint8Array(size);
    });
    try {
      const lengths = [];
      for await (const file of provider.exportWorkspace(computer, ctx))
        lengths.push(file.content.byteLength);
      expect(lengths).toEqual(sizes);
      expect(peakBytes).toBe(12 * 1024 * 1024);
    } finally {
      stopBrowsers.mockRestore();
    }
  });

  it("skips a file removed during export but preserves other read failures", async () => {
    const stopBrowsers = vi.spyOn(LinuxDesktop.prototype, "stopBrowsers").mockResolvedValue();
    sandbox.exec.mockResolvedValue({
      exitCode: 0,
      stdout: "gone\u0000600\u00001\u0000kept\u0000600\u00001\u0000",
    });
    const content = Uint8Array.of(7);
    sandbox.files.read
      .mockRejectedValueOnce(
        new SandboxFileNotFoundError({ operation: "read", path: "gone", message: "missing" }),
      )
      .mockResolvedValue(content);
    try {
      const files = [];
      for await (const file of provider.exportWorkspace(computer, ctx)) files.push(file);
      expect(files).toEqual([{ path: "kept", content, executable: false }]);
      sandbox.files.read.mockRejectedValue(new Error("transfer failed"));
      await expect(provider.exportWorkspace(computer, ctx).next()).rejects.toThrow(
        "transfer failed",
      );
    } finally {
      stopBrowsers.mockRestore();
    }
  });
});
