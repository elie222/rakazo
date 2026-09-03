import type { Sandbox } from "@daytona/sdk";
import { describe, expect, it, vi } from "vitest";
import { DaytonaSandboxProvider, type DaytonaSandboxSdk } from "./daytona-sandbox.js";

const context = {
  operationId: "test",
  traceId: "test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};

describe("DaytonaSandboxProvider", () => {
  it("implements the portable command, file, screen, and computer-use contract", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({ apiKey: "test-key" }, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    await provider.prepare(computer, context);

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
    expect(exported).toContainEqual({
      path: "bin/tool",
      content: binary,
      executable: true,
    });

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
    expect(reconnected).toMatchObject({
      providerRef: "existing",
      fresh: false,
    });

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

    const computers = await Promise.all([
      provider.provision(request, context),
      provider.provision(request, context),
    ]);
    await Promise.all(computers.map((computer) => provider.prepare(computer, context)));

    expect(fixture.get).toHaveBeenCalledTimes(1);
    expect(fixture.start).toHaveBeenCalledTimes(1);
    expect(
      fixture.executeCommand.mock.calls.filter(([command]) =>
        String(command).startsWith("mkdir -p -- "),
      ),
    ).toHaveLength(1);
  });

  it("returns a fresh reference before workspace preparation fails", async () => {
    const fixture = daytonaFixture({ prepareFails: true });
    const provider = new DaytonaSandboxProvider({ apiKey: "test-key" }, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);

    expect(computer).toMatchObject({ providerRef: "daytona-box", fresh: true });
    await expect(provider.prepare(computer, context)).rejects.toThrow(
      /could not create Daytona workspace/,
    );
    expect(fixture.deleteSandbox).not.toHaveBeenCalled();
  });

  it("surfaces transient stop failures so cleanup can retry", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({ apiKey: "test-key" }, fixture.client);
    const computer = await provider.provision({ botId: "bot-a", homePath: "/unused" }, context);
    await provider.prepare(computer, context);
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

  it("gives Team bots distinct Daytona previews without a second computerUse.start", async () => {
    const fixture = daytonaFixture();
    const provider = new DaytonaSandboxProvider({ apiKey: "test-key" }, fixture.client);
    const computer = await provider.provision({ botId: "team-home", homePath: "/unused" }, context);
    await provider.prepare(computer, context);
    const writer = { ...context, botId: "writer" };
    const researcher = { ...context, botId: "researcher" };
    const screenRegistry = createScreenRegistryResponder();

    fixture.getSignedPreviewUrl.mockImplementation(async (port: number) => ({
      url: `https://${port}-preview.proxy.daytona.test`,
      token: `token-${port}`,
    }));
    fixture.executeCommand.mockImplementation(async (command: string) => {
      const registryResult = screenRegistry(command);
      if (registryResult) return registryResult;
      if (command.includes("command -v Xvfb")) return { exitCode: 0, result: "" };
      if (command.includes("RAKAZO_SCREEN_PASSWORD=")) {
        return {
          exitCode: 0,
          result: "RAKAZO_SCREEN_PASSWORD=test-view-password\n",
        };
      }
      if (command.includes("scrot") || command.includes("import")) {
        return {
          exitCode: 0,
          result: `${Buffer.from([1, 2, 3]).toString("base64")}\nCURSOR X=1 Y=2`,
        };
      }
      if (command.includes("xdotool")) return { exitCode: 0, result: "" };
      return { exitCode: 0, result: "" };
    });

    await provider.observe(computer, writer);
    await provider.observe(computer, researcher);
    const writerView = await provider.connectScreen(
      computer,
      { view: "stream", interactive: false },
      writer,
    );
    const researcherView = await provider.connectScreen(
      computer,
      { view: "stream", interactive: false },
      researcher,
    );
    expect(writerView.url).toContain("6080-preview");
    expect(researcherView.url).toContain("6082-preview");
    expect(researcherView.url).toContain("password=test-view-password");
    expect(fixture.computerUse.start).toHaveBeenCalledTimes(1);
    expect(fixture.click).not.toHaveBeenCalled();

    await provider.act(
      computer,
      {
        actions: [{ kind: "pointer", type: "click", x: 4, y: 5 }],
        observe: false,
      },
      researcher,
    );
    expect(
      fixture.executeCommand.mock.calls.some(([command]) => command.includes("DISPLAY=:2")),
    ).toBe(true);
    expect(fixture.click).not.toHaveBeenCalled();

    await provider.releaseScreen(computer, writer);
    await expect(provider.observe(computer, researcher)).resolves.toMatchObject({
      width: 1280,
      height: 800,
    });

    const researcherControl = await provider.connectScreen(
      computer,
      { view: "stream", interactive: true, controlToken: "lease-1" },
      researcher,
    );
    expect(researcherControl.url).toContain("6083-preview");
    expect(researcherControl.url).not.toContain("6082-preview");
    expect(
      fixture.executeCommand.mock.calls.some(([command]) =>
        String(command).includes("-rfbport 5903"),
      ),
    ).toBe(true);

    expect(provider.describe().capabilities.multiScreen).toBe(true);
  });
});

function daytonaFixture(options: { id?: string; state?: string; prepareFails?: boolean } = {}) {
  const files = new Map<string, Buffer>();
  const modes = new Map<string, string>();
  const id = options.id ?? "daytona-box";
  const screenRegistry = createScreenRegistryResponder();
  const executeCommand = vi.fn(
    async (command: string, _cwd?: string, _env?: Record<string, string>, _timeout?: number) => {
      const registryResult = screenRegistry(command);
      if (registryResult) return registryResult;
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
  const click = vi.fn(async () => ({}));
  const press = vi.fn(async () => undefined);
  const type = vi.fn(async () => undefined);
  const scroll = vi.fn(async () => true);
  const getSignedPreviewUrl = vi.fn(async (_port: number) => ({
    url: "https://6080-preview.proxy.daytona.test",
    token: "preview-token",
  }));
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
        getInfo: vi.fn(async () => ({
          displays: [{ width: 1280, height: 800, isActive: true }],
        })),
        getWindows: vi.fn(async () => ({
          windows: [{ id: 7, title: "Browser", isActive: true }],
        })),
      },
      mouse: {
        getPosition: vi.fn(async () => ({ x: 10, y: 20 })),
        move: vi.fn(async () => ({ x: 10, y: 20 })),
        click,
        drag,
        scroll,
      },
      keyboard: { press, type },
    },
    getUserHomeDir: vi.fn(async () => "/home/daytona"),
    getWorkDir: vi.fn(async () => "/home/daytona"),
    getSignedPreviewUrl,
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
    computerUse: sandbox.computerUse,
    start,
    stop,
    deleteSandbox,
    getSignedPreviewUrl,
    expireSignedPreviewUrl,
    drag,
    click,
    press,
    type,
    scroll,
  };
}

function createScreenRegistryResponder() {
  const slots = new Map<string, number>();
  return (command: string): { exitCode: number; result: string } | undefined => {
    const key = command.match(/slot="\$dir\/([a-f0-9]+)\.slot"/)?.[1];
    if (!key) return undefined;
    if (command.includes("RAKAZO_SCREEN_INDEX=")) {
      let index = slots.get(key);
      if (index === undefined) {
        index = Array.from({ length: 8 }, (_, candidate) => candidate).find(
          (candidate) => ![...slots.values()].includes(candidate),
        );
        if (index === undefined) return { exitCode: 75, result: "" };
        slots.set(key, index);
      }
      return { exitCode: 0, result: `RAKAZO_SCREEN_INDEX=${index}\n` };
    }
    if (command.includes("RAKAZO_SCREEN_RELEASE=")) {
      const index = slots.get(key);
      if (index === undefined) return { exitCode: 0, result: "RAKAZO_SCREEN_RELEASE=missing\n" };
      slots.delete(key);
      return { exitCode: 0, result: `RAKAZO_SCREEN_RELEASE=${index}\n` };
    }
    return undefined;
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
