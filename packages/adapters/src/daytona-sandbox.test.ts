import type { Sandbox } from "@daytona/sdk";
import { describe, expect, it, vi } from "vitest";
import { DaytonaSandboxProvider, type DaytonaSandboxSdk } from "./daytona-sandbox.js";

const context = {
  operationId: "test",
  traceId: "test",
  workspaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};

describe("DaytonaSandboxProvider", () => {
  it("implements the portable command, file, screen, and computer-use contract", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({ apiKey: "test-key" }, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);

    expect(computer).toMatchObject({
      id: "daytona-box",
      kind: "daytona",
      providerRef: "daytona-box",
      fresh: true,
    });
    expect(fixture.create).toHaveBeenCalledWith(
      expect.objectContaining({
        labels: { botId: "bot-a", rakazo: "computer" },
        envVars: { VNC_RESOLUTION: "1280x800" },
      }),
      { timeout: 120 },
    );

    const events = [];
    for await (const event of provider.execute(computer, { argv: ["echo", "hello"] }, context)) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "stdout", data: "hello\n" },
      { type: "exit", code: 0 },
    ]);
    expect(fixture.executeCommand).toHaveBeenCalledWith(
      "'echo' 'hello'",
      "/home/daytona/rakazo-home",
      undefined,
      300,
    );

    const binary = Uint8Array.from([0, 255, 1, 128]);
    await provider.writeFile(
      computer,
      { path: "bin/tool", content: binary, executable: true },
      context,
    );
    expect(await provider.readFile(computer, "bin/tool", context)).toEqual(binary);
    expect(await provider.listFiles(computer, "bin", context)).toEqual([
      { path: "bin/tool", kind: "file", size: 4, executable: true },
    ]);
    const exported = [];
    for await (const file of provider.exportWorkspace(computer, context)) exported.push(file);
    expect(exported).toContainEqual({ path: "bin/tool", content: binary, executable: true });

    const observation = await provider.observe(computer, context);
    expect(observation).toMatchObject({
      mimeType: "image/png",
      width: 1280,
      height: 800,
      cursor: { x: 10, y: 20 },
      activeWindow: { id: "7", title: "Browser" },
    });
    expect(observation.image).toEqual(Uint8Array.from([1, 2, 3]));

    const result = await provider.act(
      computer,
      {
        actions: [
          { kind: "pointer", type: "down", x: 10, y: 20 },
          { kind: "pointer", type: "up", x: 30, y: 40 },
          { kind: "key", key: "enter" },
          { kind: "clipboard", text: "hello" },
          { kind: "scroll", direction: "down", amount: 2 },
        ],
        observe: false,
      },
      context,
    );
    expect(result).toEqual({ completed: 5 });
    expect(fixture.drag).toHaveBeenCalledWith(10, 20, 30, 40, "left");
    expect(fixture.press).toHaveBeenCalledWith("enter", undefined);
    expect(fixture.type).toHaveBeenCalledWith("hello");
    expect(fixture.scroll).toHaveBeenCalledWith(10, 20, "down", 2);

    const [screen, interactiveScreen] = await Promise.all([
      provider.connectScreen(computer, { view: "stream", interactive: false }, context),
      provider.connectScreen(computer, { view: "stream", interactive: true }, context),
    ]);
    expect(screen.url).toContain("/vnc.html");
    expect(screen.url).toContain("view_only=true");
    await screen.close();
    expect(interactiveScreen.url).toContain("view_only=false");
    expect(fixture.getSignedPreviewUrl).toHaveBeenCalledTimes(1);

    await provider.stop(computer, context);
    expect(fixture.expireSignedPreviewUrl).toHaveBeenCalledWith(6080, "preview-token");
    expect(fixture.stop).toHaveBeenCalledWith(120);
  });

  it("reconnects stopped sandboxes and replaces missing ones", async () => {
    const existing = daytonaFixture({ id: "existing", state: "stopped" });
    const provider = new DaytonaSandboxProvider({ apiKey: "test-key" }, existing.client);
    const reconnected = await provider.provision(
      {
        botId: "bot-a",
        homePath: "/unused",
        providerRef: "existing",
        providerKind: "daytona",
      },
      context,
    );
    expect(existing.start).toHaveBeenCalledWith(120);
    expect(reconnected).toMatchObject({ providerRef: "existing", fresh: false });

    const replacement = daytonaFixture({ id: "replacement" });
    replacement.get.mockRejectedValueOnce({ statusCode: 404 });
    const replacingProvider = new DaytonaSandboxProvider(
      { apiKey: "test-key" },
      replacement.client,
    );
    const replaced = await replacingProvider.provision(
      {
        botId: "bot-b",
        homePath: "/unused",
        providerRef: "missing",
        providerKind: "daytona",
      },
      context,
    );
    expect(replaced).toMatchObject({ providerRef: "replacement", fresh: true });
  });

  it("coalesces concurrent reconnect and workspace preparation", async () => {
    const fixture = daytonaFixture({ id: "shared", state: "stopped" });
    const provider = new DaytonaSandboxProvider({ apiKey: "test-key" }, fixture.client);
    const request = {
      botId: "bot-a",
      homePath: "/unused",
      providerRef: "shared",
      providerKind: "daytona" as const,
    };

    await Promise.all([provider.provision(request, context), provider.provision(request, context)]);

    expect(fixture.get).toHaveBeenCalledTimes(1);
    expect(fixture.start).toHaveBeenCalledTimes(1);
    expect(
      fixture.executeCommand.mock.calls.filter(([command]) =>
        String(command).startsWith("mkdir -p -- "),
      ),
    ).toHaveLength(1);
  });

  it("deletes a fresh sandbox when workspace preparation fails", async () => {
    const fixture = daytonaFixture({ prepareFails: true });
    const provider = new DaytonaSandboxProvider({ apiKey: "test-key" }, fixture.client);

    await expect(
      provider.provision({ botId: "bot-a", homePath: "/unused" }, context),
    ).rejects.toThrow(/could not create Daytona workspace/);
    expect(fixture.deleteSandbox).toHaveBeenCalledWith(120, true);
  });

  it("surfaces transient stop failures so cleanup can retry", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({ apiKey: "test-key" }, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    fixture.stop.mockRejectedValueOnce(new Error("temporary Daytona outage"));

    await expect(provider.stop(computer, context)).rejects.toThrow("temporary Daytona outage");
    await expect(provider.stop(computer, context)).resolves.toBeUndefined();
    expect(fixture.get).toHaveBeenCalledTimes(1);
    expect(fixture.stop).toHaveBeenCalledTimes(2);
  });

  it("distinguishes transient lookup failures from an already deleted sandbox", async () => {
    const fixture = daytonaFixture({ id: "remote" });
    const provider = new DaytonaSandboxProvider({ apiKey: "test-key" }, fixture.client);
    const computer = {
      id: "remote",
      botId: "bot-a",
      kind: "daytona" as const,
      providerRef: "remote",
      fresh: false,
    };
    fixture.get.mockRejectedValueOnce(new Error("temporary Daytona outage"));
    fixture.get.mockRejectedValueOnce({ statusCode: 404 });

    await expect(provider.stop(computer, context)).rejects.toThrow("temporary Daytona outage");
    await expect(provider.stop(computer, context)).resolves.toBeUndefined();
  });
});

function daytonaFixture(options: { id?: string; state?: string; prepareFails?: boolean } = {}) {
  const files = new Map<string, Buffer>();
  const modes = new Map<string, string>();
  const id = options.id ?? "daytona-box";
  const executeCommand = vi.fn(
    async (command: string, _cwd?: string, _env?: Record<string, string>, _timeout?: number) => {
      if (command === "'echo' 'hello'") return { exitCode: 0, result: "hello\n" };
      if (options.prepareFails && command.startsWith("mkdir -p -- ")) {
        return { exitCode: 1, result: "could not create Daytona workspace" };
      }
      if (command.startsWith("chmod 700 -- ")) {
        for (const match of command.matchAll(/'([^']+)'/g)) modes.set(match[1]!, "0755");
      }
      return { exitCode: 0, result: "" };
    },
  );
  const uploadFile = vi.fn(async (content: Buffer, target: string) => {
    files.set(target, Buffer.from(content));
    modes.set(target, modes.get(target) ?? "0644");
  });
  const downloadFile = vi.fn(async (target: string) => Buffer.from(files.get(target) ?? []));
  const listFiles = vi.fn(async (directory: string) => {
    const prefix = `${directory.replace(/\/$/, "")}/`;
    const entries = new Map<string, ReturnType<typeof fileInfo>>();
    for (const [target, content] of files) {
      if (!target.startsWith(prefix)) continue;
      const remainder = target.slice(prefix.length);
      const [name, ...rest] = remainder.split("/");
      if (!name) continue;
      entries.set(
        name,
        fileInfo(name, rest.length > 0, rest.length ? 0 : content.byteLength, modes.get(target)),
      );
    }
    return [...entries.values()];
  });
  const start = vi.fn(async () => undefined);
  const stop = vi.fn(async () => undefined);
  const deleteSandbox = vi.fn(async () => undefined);
  const expireSignedPreviewUrl = vi.fn(async () => undefined);
  const drag = vi.fn(async () => ({}));
  const press = vi.fn(async () => undefined);
  const type = vi.fn(async () => undefined);
  const scroll = vi.fn(async () => true);
  const sandbox = {
    id,
    state: options.state ?? "started",
    process: { executeCommand },
    fs: {
      uploadFile,
      downloadFile,
      listFiles,
      getFileDetails: vi.fn(async (target: string) =>
        fileInfo(target.split("/").at(-1) ?? target, false, files.get(target)?.byteLength ?? 0),
      ),
    },
    computerUse: {
      start: vi.fn(async () => ({ message: "started" })),
      stop: vi.fn(async () => ({ message: "stopped" })),
      screenshot: {
        takeFullScreen: vi.fn(async () => ({
          screenshot: Buffer.from([1, 2, 3]).toString("base64"),
        })),
      },
      display: {
        getInfo: vi.fn(async () => ({ displays: [{ width: 1280, height: 800, isActive: true }] })),
        getWindows: vi.fn(async () => ({ windows: [{ id: 7, title: "Browser", isActive: true }] })),
      },
      mouse: {
        getPosition: vi.fn(async () => ({ x: 10, y: 20 })),
        move: vi.fn(async () => ({ x: 10, y: 20 })),
        click: vi.fn(async () => ({})),
        drag,
        scroll,
      },
      keyboard: { press, type },
    },
    getUserHomeDir: vi.fn(async () => "/home/daytona"),
    getWorkDir: vi.fn(async () => "/home/daytona"),
    getSignedPreviewUrl: vi.fn(async () => ({
      url: "https://6080-preview.proxy.daytona.test",
      token: "preview-token",
    })),
    expireSignedPreviewUrl,
    refreshActivity: vi.fn(async () => undefined),
    start,
    stop,
    delete: deleteSandbox,
  } as unknown as Sandbox;
  const create = vi.fn(async () => sandbox);
  const get = vi.fn(async () => sandbox);
  return {
    sandbox,
    client: { create, get } satisfies DaytonaSandboxSdk,
    create,
    get,
    executeCommand,
    start,
    stop,
    deleteSandbox,
    getSignedPreviewUrl: sandbox.getSignedPreviewUrl,
    expireSignedPreviewUrl,
    drag,
    press,
    type,
    scroll,
  };
}

function fileInfo(name: string, isDir: boolean, size: number, mode = "0644") {
  return {
    group: "daytona",
    isDir,
    modTime: "",
    modifiedAt: "2026-01-01T00:00:00Z",
    mode,
    name,
    owner: "daytona",
    permissions: mode === "0755" ? "rwxr-xr-x" : "rw-r--r--",
    size,
  };
}
