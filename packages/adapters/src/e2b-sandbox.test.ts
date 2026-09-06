import { createServer } from "node:http";
import { Sandbox, TimeoutError } from "@e2b/desktop";
import { describe, expect, it, vi } from "vitest";
import { shouldSkipPortableWorkspaceFile } from "./computer-workspace.js";
import { E2BSandboxProvider, type E2BSandboxSdk, isSandboxGoneError } from "./e2b-sandbox.js";
import { desktopCommandResponder } from "./linux-desktop.test-support.js";

const context = {
  operationId: "e2b-test",
  traceId: "e2b-test",
  spaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};

describe("E2B computer backend", () => {
  it("revokes an extra display's control without starting or waiting for its view", async () => {
    const command = vi.fn(async (value: string) => {
      if (value.includes("RAKAZO_SCREEN_INDEX=")) {
        return { stdout: "RAKAZO_SCREEN_INDEX=1\n", stderr: "", exitCode: 0 };
      }
      if (value.includes("RAKAZO_SCREEN_PASSWORD=") || value.includes("flock 8")) {
        throw new Error("extra view is unavailable");
      }
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const provider = new E2BSandboxProvider("test-key", {
      connect: vi.fn(async () => ({
        sandboxId: "existing",
        display: ":0",
        commands: { run: command },
      })),
    } as unknown as E2BSandboxSdk);

    await expect(
      provider.setScreenControl(
        { id: "existing", providerRef: "existing", kind: "e2b", botId: "bot" },
        false,
        { ...context, botId: "bot" },
        "expired-control-token",
      ),
    ).resolves.toBeUndefined();
    expect(command).toHaveBeenCalledTimes(1);
    expect(command).toHaveBeenLastCalledWith(
      expect.stringContaining("expired-control-token"),
      expect.objectContaining({ signal: context.signal }),
    );
  });

  it("reconnects concurrent primary viewers without using the SDK's global VNC lifecycle", async () => {
    const command = vi.fn(async (_value: string) => ({
      stdout: "RAKAZO_DESKTOP=0:savedkey\n",
      stderr: "",
      exitCode: 0,
    }));
    const globalStream = vi.fn(async () => {
      throw new Error("Stream is already running");
    });
    const sdk = {
      connect: vi.fn(async () => ({
        sandboxId: "existing",
        display: ":0",
        getHost: (port: number) => `${port}-desktop.test`,
        commands: { run: command },
        stream: { start: globalStream, stop: globalStream },
      })),
    } as unknown as E2BSandboxSdk;
    const computer = {
      id: "existing",
      providerRef: "existing",
      kind: "e2b" as const,
      botId: "bot",
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const [first, second] = await Promise.all([
      provider.connectScreen(computer, { view: "stream" }, context),
      provider.connectScreen(computer, { view: "stream" }, context),
      provider.provision({ ...computer, providerKind: "e2b", homePath: "/unused" }, context),
    ]);
    expect(sdk.connect).toHaveBeenCalledTimes(1);
    expect(first.url).toBe(second.url);
    expect(new URL(first.url!).searchParams.get("path")).toBe("websockify?token=savedkey");

    const restarted = new E2BSandboxProvider("test-key", sdk);
    const restored = await restarted.connectScreen(computer, { view: "stream" }, context);
    expect(restored.url).toBe(first.url);
    const commandsBeforeClose = command.mock.calls.length;
    await first.close();
    expect(command).toHaveBeenCalledTimes(commandsBeforeClose);
    expect(globalStream).not.toHaveBeenCalled();
  });

  it("only filters transient cache files inside portable browser profiles", () => {
    expect(shouldSkipPortableWorkspaceFile("project/Cache/important.txt")).toBe(false);
    expect(shouldSkipPortableWorkspaceFile("project/lock")).toBe(false);
    expect(shouldSkipPortableWorkspaceFile(".browser-profiles/chromium/Cache/data")).toBe(true);
    expect(shouldSkipPortableWorkspaceFile(".browser-profiles/chromium/SingletonLock")).toBe(true);
  });

  it.each([
    "ECONNRESET",
    "ECONNREFUSED",
    "EAI_AGAIN",
    "EHOSTUNREACH",
    "ENETUNREACH",
    "ENOTFOUND",
    "UND_ERR_CONNECT_TIMEOUT",
    "UND_ERR_SOCKET",
    undefined,
  ])("preserves an existing sandbox after a %s transport failure", async (code) => {
    const desktop = { sandboxId: "fresh-e2b-box" } as unknown as Sandbox;
    const failure = new Error("fetch failed", {
      cause: Object.assign(new Error("transport unavailable"), { code }),
    });
    const sdk: E2BSandboxSdk = {
      create: vi.fn(async () => desktop),
      connect: vi.fn().mockRejectedValueOnce(failure).mockResolvedValue({ sandboxId: "existing" }),
      pause: vi.fn(async () => undefined),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);

    const request = {
      botId: "bot-1",
      homePath: "/unused",
      providerRef: "existing",
      providerKind: "e2b" as const,
    };
    await expect(provider.provision(request, context)).rejects.toBe(failure);
    expect(sdk.create).not.toHaveBeenCalled();
    await expect(provider.provision(request, context)).resolves.toMatchObject({
      providerRef: "existing",
      fresh: false,
    });
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it("creates a replacement when the provider confirms the sandbox no longer exists", async () => {
    const sdk: E2BSandboxSdk = {
      create: vi.fn().mockResolvedValue({ sandboxId: "replacement" }),
      connect: vi.fn().mockRejectedValue(
        Object.assign(new Error("Sandbox not found"), {
          name: "SandboxNotFoundError",
        }),
      ),
      pause: vi.fn(),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    await expect(
      provider.provision(
        {
          botId: "bot-1",
          homePath: "/unused",
          providerRef: "missing",
          providerKind: "e2b",
        },
        context,
      ),
    ).resolves.toMatchObject({ providerRef: "replacement", fresh: true });
    expect(sdk.create).toHaveBeenCalledOnce();
  });

  it.each([404, 503])(
    "uses SDK deletion semantics for a cached handle receiving %s",
    async (status) => {
      const requests: string[] = [];
      const server = createServer((request, response) => {
        requests.push(`${request.method} ${request.url}`);
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ code: status, message: "sandbox unavailable" }));
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        const address = server.address();
        if (!address || typeof address === "string") throw new Error("Missing test server address");
        const desktop = new Sandbox({
          sandboxId: "expired",
          envdVersion: "0.1.0",
          apiKey: "test-key",
          validateApiKey: false,
          debug: false,
          proxy: "",
          apiUrl: `http://127.0.0.1:${address.port}`,
        });
        const sdk: E2BSandboxSdk = {
          create: vi.fn().mockResolvedValue(desktop),
          connect: vi.fn(),
          pause: vi.fn(),
        };
        const provider = new E2BSandboxProvider("test-key", sdk);
        const computer = await provider.provision({ botId: "bot", homePath: "/unused" }, context);
        if (status === 404) {
          await expect(provider.destroy(computer, context)).resolves.toBeUndefined();
        } else {
          await expect(provider.destroy(computer, context)).rejects.toThrow();
        }
        expect(requests).toEqual(["DELETE /sandboxes/expired"]);
        expect(sdk.connect).not.toHaveBeenCalled();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );

  it("gives screen setup commands a real timeout and surfaces a failed one as unavailable", async () => {
    const run = vi.fn(async (_command: string, opts?: { timeoutMs?: number }) => {
      // The SDK throws on a non-zero exit rather than returning the result, and caps the
      // command at 60s unless a timeout is passed.
      if ((opts?.timeoutMs ?? 60_000) <= 60_000) {
        throw Object.assign(new Error("signal: terminated"), {
          name: "CommandExitError",
          result: { exitCode: -1, stdout: "", stderr: "", error: "signal: terminated" },
        });
      }
      throw Object.assign(new Error("boom"), {
        name: "CommandExitError",
        result: { exitCode: 1, stdout: "", stderr: "boom", error: "boom" },
      });
    });
    const desktop = {
      sandboxId: "screen-e2b-box",
      display: ":0",
      commands: { run },
    } as unknown as Sandbox;
    const sdk: E2BSandboxSdk = {
      create: vi.fn(async () => desktop),
      connect: vi.fn(async () => desktop),
      pause: vi.fn(async () => undefined),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const computer = {
      id: "screen-e2b-box",
      botId: "bot-1",
      kind: "e2b" as const,
      providerRef: "screen-e2b-box",
      fresh: false,
    };

    await expect(provider.connectScreen(computer, { view: "stream" }, context)).rejects.toThrow(
      Error,
    );
    expect(run.mock.calls[0]?.[1]?.timeoutMs).toBeGreaterThan(60_000);
  });

  it("surfaces a setup timeout without treating it as a missing sandbox", async () => {
    const run = vi.fn(async () => {
      throw new TimeoutError("the operation timed out");
    });
    const desktop = {
      sandboxId: "timeout-e2b-box",
      display: ":0",
      commands: { run },
    } as unknown as Sandbox;
    const sdk: E2BSandboxSdk = {
      create: vi.fn(async () => desktop),
      connect: vi.fn(async () => desktop),
      pause: vi.fn(async () => undefined),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const computer = {
      id: "timeout-e2b-box",
      botId: "bot-1",
      kind: "e2b" as const,
      providerRef: "timeout-e2b-box",
      fresh: false,
    };

    await expect(provider.connectScreen(computer, { view: "stream" }, context)).rejects.toThrow(
      Error,
    );
  });

  it("prepares a reused computer idempotently", async () => {
    let profilesConfigured = false;
    const command = vi.fn(async (value: string) => {
      if (value.startsWith('test "$(readlink') && !profilesConfigured) {
        throw new Error("profiles are not configured");
      }
      if (value.includes("ln -s")) profilesConfigured = true;
      return { stdout: "", stderr: "", exitCode: 0 };
    });
    const desktop = {
      sandboxId: "reused-e2b-box",
      commands: { run: command },
      launch: vi.fn(async () => undefined),
      open: vi.fn(async () => undefined),
    } as unknown as Sandbox;
    const sdk: E2BSandboxSdk = {
      create: vi.fn(async () => desktop),
      connect: vi.fn(async () => desktop),
      pause: vi.fn(async () => undefined),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const computer = await provider.provision(
      {
        botId: "bot-1",
        homePath: "/unused",
        providerRef: "reused-e2b-box",
        providerKind: "e2b",
      },
      context,
    );

    await provider.prepare(computer, context);
    await provider.prepare(computer, context);

    expect(command.mock.calls.every(([value]) => value.includes("apt-get"))).toBe(true);
    expect(desktop.launch).not.toHaveBeenCalled();
  });

  it("opens http(s) URLs through the named browser launcher", async () => {
    const respond = desktopCommandResponder();
    const command = vi.fn(
      async (value: string) => respond(value) ?? { stdout: "", stderr: "", exitCode: 0 },
    );
    const launch = vi.fn(async () => undefined);
    const open = vi.fn(async () => undefined);
    const desktop = {
      sandboxId: "e2b-open-url-box",
      display: ":0",
      commands: { run: command },
      files: { makeDir: vi.fn(async () => undefined) },
      launch,
      open,
    } as unknown as Sandbox;
    const provider = new E2BSandboxProvider("test-key", {
      create: vi.fn(async () => desktop),
      connect: vi.fn(async () => desktop),
      pause: vi.fn(async () => undefined),
    });
    const computer = await provider.provision(
      { botId: "bot-1", homePath: "/unused", providerKind: "e2b" },
      context,
    );

    await provider.act(
      computer,
      { actions: [{ kind: "open", path: "https://example.com/docs" }], observe: false },
      context,
    );
    expect(command).toHaveBeenCalledWith(
      expect.stringContaining("browser-launch-20"),
      expect.anything(),
    );
    expect(command).toHaveBeenLastCalledWith(
      expect.stringContaining("https://example.com/docs"),
      expect.anything(),
    );
    expect(launch).not.toHaveBeenCalled();
    expect(open).not.toHaveBeenCalled();

    await provider.act(
      computer,
      { actions: [{ kind: "open", path: "notes/readme.md" }], observe: false },
      context,
    );
    expect(command).toHaveBeenLastCalledWith(
      expect.stringContaining("/home/user/rakazo-home/notes/readme.md"),
      expect.anything(),
    );
  });

  it("controls the desktop and exposes a portable workspace", async () => {
    const files = new Map<string, Uint8Array>();
    const leftClick = vi.fn(async () => undefined);
    const typeText = vi.fn(async () => undefined);
    const respond = desktopCommandResponder();
    const command = vi.fn(async (value: string, _options?: Record<string, unknown>) => {
      const response = respond(value);
      if (response) return response;
      if (value.includes("hang")) {
        throw new TimeoutError("command timed out");
      }
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        disconnect: async () => undefined,
      };
    });
    const getStreamUrl = vi.fn(() => "https://desktop.test/vnc.html");
    const streamStart = vi.fn(async () => undefined);
    const streamStop = vi.fn(async () => undefined);
    const desktop = {
      sandboxId: "e2b-test-box",
      display: ":0",
      getHost: (port: number) => `${port}-desktop.test`,
      commands: { run: command },
      files: {
        makeDir: vi.fn(async () => undefined),
        write: vi.fn(async (entries: Array<{ path: string; data: ArrayBuffer }>) => {
          for (const entry of entries) files.set(entry.path, new Uint8Array(entry.data));
        }),
        read: vi.fn(async (filePath: string) => {
          const content = files.get(filePath);
          if (!content) throw new Error("missing file");
          return content;
        }),
        list: vi.fn(async (directory: string) => {
          const prefix = `${directory.replace(/\/$/, "")}/`;
          return [...files.entries()]
            .filter(([filePath]) => filePath.startsWith(prefix))
            .map(([filePath, content]) => ({
              name: filePath.slice(prefix.length),
              type: "file" as const,
              size: content.byteLength,
              mode: 0o600,
            }));
        }),
      },
      stream: {
        start: streamStart,
        stop: streamStop,
        getAuthKey: () => "screen-key",
        getUrl: getStreamUrl,
      },
      launch: vi.fn(async () => undefined),
      open: vi.fn(async () => undefined),
      screenshot: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
      getScreenSize: vi.fn(async () => ({ width: 1280, height: 800 })),
      getCursorPosition: vi.fn(async () => ({ x: 10, y: 20 })),
      getCurrentWindowId: vi.fn(async () => "42"),
      getWindowTitle: vi.fn(async () => "Browser"),
      leftClick,
      rightClick: vi.fn(async () => undefined),
      moveMouse: vi.fn(async () => undefined),
      mousePress: vi.fn(async () => undefined),
      mouseRelease: vi.fn(async () => undefined),
      write: typeText,
      press: vi.fn(async () => undefined),
      scroll: vi.fn(async () => undefined),
      wait: vi.fn(async () => undefined),
      setTimeout: vi.fn(async () => undefined),
      pause: vi.fn(async () => undefined),
      kill: vi.fn(async () => undefined),
    } as unknown as Sandbox;
    const sdk: E2BSandboxSdk = {
      create: vi.fn(async () => desktop),
      connect: vi.fn(async () => desktop),
      pause: vi.fn(async () => undefined),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const computer = await provider.provision(
      {
        botId: "bot-1",
        homePath: "/unused",
        providerRef: "foreign-provider-machine",
        providerKind: "docker",
      },
      context,
    );
    expect(sdk.connect).not.toHaveBeenCalled();
    await provider.prepare(computer, context);
    await provider.importWorkspace(
      computer,
      (async function* () {
        // Empty durable home on first boot.
      })(),
      context,
    );

    const timeoutEvents = [];
    for await (const event of provider.execute(
      computer,
      { argv: ["hang"], timeoutMs: 42 },
      context,
    )) {
      timeoutEvents.push(event);
    }
    expect(timeoutEvents).toEqual([
      { type: "stderr", data: "command timed out after 42 ms\n" },
      { type: "exit", code: 124 },
    ]);
    expect(command).toHaveBeenCalledWith(
      "'hang'",
      expect.objectContaining({ timeoutMs: 42, signal: context.signal }),
    );

    await provider.writeFile(
      computer,
      {
        path: "notes/result.txt",
        content: new TextEncoder().encode("portable"),
      },
      context,
    );
    expect(
      new TextDecoder().decode(await provider.readFile(computer, "notes/result.txt", context)),
    ).toBe("portable");
    expect(await provider.listFiles(computer, "notes", context)).toEqual([
      { path: "notes/result.txt", kind: "file", size: 8 },
    ]);

    const result = await provider.act(
      computer,
      {
        actions: [
          { kind: "pointer", type: "click", x: 100, y: 120 },
          { kind: "clipboard", text: "hello" },
        ],
        observe: true,
      },
      context,
    );
    expect(command).toHaveBeenCalledWith(
      expect.stringContaining("xdotool mousemove 100 120 click 1"),
      expect.anything(),
    );
    expect(command).toHaveBeenCalledWith(
      expect.stringContaining("xdotool type"),
      expect.anything(),
    );
    expect(result.observation).toMatchObject({ width: 1280, height: 800 });
    expect(command.mock.calls.some(([value]) => String(value).includes(".browser-profiles"))).toBe(
      true,
    );
    expect(command.mock.calls.some(([value]) => String(value).includes("cp -a"))).toBe(false);
    const [screen] = await Promise.all([
      provider.connectScreen(computer, { view: "stream" }, context),
      provider.connectScreen(computer, { view: "stream" }, context),
    ]);
    expect(new URL(screen.url!).searchParams.get("path")).toMatch(/^websockify\?token=view-/);
    const control = await provider.connectScreen(
      computer,
      { view: "stream", interactive: true, controlToken: "lease-1" },
      context,
    );
    expect(control.url).toContain("6100-desktop.test");
    expect(new URL(control.url!).searchParams.get("path")).toBe("websockify?token=lease-1");
    await provider.setScreenControl(computer, false, context, "lease-1");
    await screen.close();
    expect(streamStop).not.toHaveBeenCalled();
    await provider.stop(computer, context);
    expect(desktop.pause).toHaveBeenCalled();
  });

  it("gives Team bots distinct E2B screens and shared files", async () => {
    const files = new Map<string, Uint8Array>();
    const respond = desktopCommandResponder();
    const command = vi.fn(
      async (value: string) => respond(value) ?? { stdout: "", stderr: "", exitCode: 0 },
    );
    const desktop = {
      sandboxId: "e2b-shared",
      display: ":0",
      getHost: (port: number) => `${port}-desktop.test`,
      commands: { run: command },
      files: {
        makeDir: vi.fn(async () => undefined),
        write: vi.fn(async (entries: Array<{ path: string; data: ArrayBuffer }>) => {
          for (const entry of entries) files.set(entry.path, new Uint8Array(entry.data));
        }),
        read: vi.fn(async (filePath: string) => {
          const content = files.get(filePath);
          if (!content) throw new Error("missing file");
          return content;
        }),
        list: vi.fn(async (directory: string) => {
          const prefix = `${directory.replace(/\/$/, "")}/`;
          return [...files.entries()]
            .filter(([filePath]) => filePath.startsWith(prefix))
            .map(([filePath, content]) => ({
              name: filePath.slice(prefix.length),
              type: "file" as const,
              size: content.byteLength,
              mode: 0o600,
            }));
        }),
      },
      stream: {
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
        getAuthKey: () => "key",
        getUrl: () => "https://6100-desktop.test/vnc.html",
      },
      screenshot: vi.fn(async () => new Uint8Array([137, 80, 78, 71])),
      getScreenSize: vi.fn(async () => ({ width: 1280, height: 800 })),
      getCursorPosition: vi.fn(async () => ({ x: 1, y: 1 })),
      getCurrentWindowId: vi.fn(async () => "1"),
      getWindowTitle: vi.fn(async () => "Desk"),
      leftClick: vi.fn(async () => undefined),
      moveMouse: vi.fn(async () => undefined),
      write: vi.fn(async () => undefined),
      wait: vi.fn(async () => undefined),
    };
    const provider = new E2BSandboxProvider("e2b_test", {
      create: vi.fn(async () => desktop as never),
      connect: vi.fn(),
      pause: vi.fn(),
    } as unknown as E2BSandboxSdk);
    const computer = await provider.provision({ botId: "team-home", homePath: "/tmp" }, context);
    const writer = { ...context, botId: "writer" };
    const researcher = { ...context, botId: "researcher" };

    await provider.observe(computer, writer);
    await provider.observe(computer, researcher);
    const writerView = await provider.connectScreen(computer, { view: "stream" }, writer);
    const researcherView = await provider.connectScreen(computer, { view: "stream" }, researcher);
    expect(writerView.url).toContain("6100-desktop.test");
    expect(researcherView.url).not.toBe(writerView.url);
    expect(researcherView.url).toContain("6100-desktop.test");
    expect(new URL(researcherView.url!).searchParams.get("path")).toMatch(
      /^websockify\?token=view-/,
    );
    expect(writerView.url).not.toBe(researcherView.url);
    expect(
      // biome-ignore lint/suspicious/noTemplateCurlyInString: generated shell parameter expansion
      command.mock.calls.some(([value]) => String(value).includes("Xvfb :${desktop_display}")),
    ).toBe(true);
    expect(command.mock.calls.some(([value]) => String(value).includes("pkill -x x11vnc"))).toBe(
      false,
    );

    await provider.act(
      computer,
      {
        actions: [{ kind: "pointer", type: "click", x: 1, y: 2 }],
        observe: false,
      },
      researcher,
    );
    expect(
      command.mock.calls.some(([value]) => String(value).includes("DISPLAY=:21 xdotool")),
    ).toBe(true);
    expect(desktop.moveMouse).not.toHaveBeenCalled();

    const control = await provider.connectScreen(
      computer,
      { view: "stream", interactive: true, controlToken: "lease-1" },
      researcher,
    );
    expect(control.url).toContain("6100-desktop.test");
    expect(new URL(control.url!).searchParams.get("path")).toBe("websockify?token=lease-1");

    await provider.writeFile(
      computer,
      { path: "shared/note.txt", content: new TextEncoder().encode("office") },
      researcher,
    );
    expect(
      new TextDecoder().decode(await provider.readFile(computer, "shared/note.txt", writer)),
    ).toBe("office");

    await provider.releaseScreen(computer, writer);
    await expect(provider.observe(computer, researcher)).resolves.toMatchObject({
      width: 1280,
      height: 800,
    });
    expect(provider.describe().capabilities.multiScreen).toBe(true);

    for (let index = 0; index < 100; index += 1) {
      await provider.observe(computer, {
        ...context,
        botId: `bot-${index + 2}`,
      });
    }
    await expect(
      provider.observe(computer, { ...context, botId: "bot-102" }),
    ).resolves.toMatchObject({
      width: 1280,
      height: 800,
    });
  });
});

describe("sandbox-gone detection", () => {
  // Verbatim wordings from @e2b/desktop 2.3.1 (e2b 2.38.3 dist).
  const gone = [
    new TimeoutError(
      "502: This error is likely due to sandbox timeout. You can modify the sandbox timeout by passing 'timeoutMs' when starting the sandbox or calling '.setTimeout' on the sandbox with the desired timeout.",
    ),
    Object.assign(new Error("Sandbox is probably not running anymore"), {
      name: "SandboxNotFoundError",
    }),
    new TimeoutError(
      "stream reset: The sandbox was killed or reached its end of life while the request was in flight.",
    ),
    Object.assign(new Error("Paused sandbox sandbox-ref-1 not found"), {
      name: "SandboxNotFoundError",
    }),
  ];
  const alive = [
    new Error("bash: x11vnc: command not found"),
    new Error("Path /home/user/rakazo-home/notes.md not found"),
    new Error("tar: /home/user/x: No such file or directory"),
    new TimeoutError(
      "canceled: This error is likely due to exceeding 'requestTimeoutMs'. You can pass the request timeout value as an option when making the request.",
    ),
    Object.assign(new Error("fetch failed"), { code: "ECONNRESET" }),
  ];

  it("recognises every sandbox-gone wording", () => {
    for (const error of gone) {
      expect(isSandboxGoneError(error), error.message).toBe(true);
    }
  });

  it("never reads a live sandbox as gone", () => {
    for (const error of alive) {
      expect(isSandboxGoneError(error), error.message).toBe(false);
    }
  });

  it("does not interpret a transport failure as sandbox loss", () => {
    expect(isSandboxGoneError(new Error("fetch failed"))).toBe(false);
  });

  it("drops a cached handle whose sandbox died and reconnects", async () => {
    const dead = {
      sandboxId: "box-1",
      setTimeout: vi.fn(async () => {
        throw new TimeoutError("502: This error is likely due to sandbox timeout.");
      }),
    } as unknown as Sandbox;
    const revived = { sandboxId: "box-1", setTimeout: vi.fn(async () => undefined) };
    const sdk: E2BSandboxSdk = {
      create: vi.fn(async () => dead),
      connect: vi.fn(async () => revived as unknown as Sandbox),
      pause: vi.fn(async () => undefined),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const ref = await provider.provision({ botId: "bot-1", homePath: "/unused" }, context);
    expect(ref.providerRef).toBe("box-1");

    vi.setSystemTime(Date.now() + 61_000);
    try {
      await provider.keepAlive?.(ref);
    } finally {
      vi.useRealTimers();
    }
    expect(dead.setTimeout).toHaveBeenCalledTimes(1);
    expect(sdk.connect).toHaveBeenCalledTimes(1);
  });

  it("forgets a dead handle on keepAlive before the 60s probe threshold", async () => {
    const dead = {
      sandboxId: "box-1",
      setTimeout: vi.fn(async () => {
        throw new TimeoutError("502: This error is likely due to sandbox timeout.");
      }),
    } as unknown as Sandbox;
    const revived = { sandboxId: "box-1", setTimeout: vi.fn(async () => undefined) };
    const sdk: E2BSandboxSdk = {
      create: vi.fn(async () => dead),
      connect: vi.fn(async () => revived as unknown as Sandbox),
      pause: vi.fn(async () => undefined),
    };
    const provider = new E2BSandboxProvider("test-key", sdk);
    const ref = await provider.provision({ botId: "bot-1", homePath: "/unused" }, context);

    // Still inside box()'s 60s cache window — keepAlive must not refresh lastTouchedAt
    // on a gone sandbox, or subsequent heartbeats would keep serving the dead handle.
    await provider.keepAlive?.(ref);
    expect(dead.setTimeout).toHaveBeenCalledTimes(1);
    expect(sdk.connect).not.toHaveBeenCalled();

    await provider.keepAlive?.(ref);
    expect(sdk.connect).toHaveBeenCalledTimes(1);
    expect(revived.setTimeout).toHaveBeenCalledTimes(1);
  });
});

function _unwrapSetupCommand(command: string): string {
  return command.startsWith("bash -c '") ? command.slice(9, -1).replaceAll(`'"'"'`, "'") : command;
}
