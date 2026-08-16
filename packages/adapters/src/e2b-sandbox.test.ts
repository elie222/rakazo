import { type Sandbox, TimeoutError } from "@e2b/desktop";
import { describe, expect, it, vi } from "vitest";
import {
  E2BSandboxProvider,
  type E2BSandboxSdk,
  shouldSkipPortableWorkspaceFile,
} from "./e2b-sandbox.js";

const context = {
  operationId: "e2b-test",
  traceId: "e2b-test",
  workspaceId: "workspace",
  userId: "user",
  signal: new AbortController().signal,
};

describe("E2B computer backend", () => {
  it("only filters transient cache files inside portable browser profiles", () => {
    expect(shouldSkipPortableWorkspaceFile("project/Cache/important.txt")).toBe(false);
    expect(shouldSkipPortableWorkspaceFile("project/lock")).toBe(false);
    expect(shouldSkipPortableWorkspaceFile(".browser-profiles/chromium/Cache/data")).toBe(true);
    expect(shouldSkipPortableWorkspaceFile(".browser-profiles/chromium/SingletonLock")).toBe(true);
  });

  it("controls the desktop and exposes a portable workspace", async () => {
    const files = new Map<string, Uint8Array>();
    const leftClick = vi.fn(async () => undefined);
    const typeText = vi.fn(async () => undefined);
    const command = vi.fn(async (value: string, _options?: Record<string, unknown>) => {
      if (value.startsWith('test "$(readlink')) throw new Error("profiles are not configured");
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
        start: vi.fn(async () => undefined),
        stop: vi.fn(async () => undefined),
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
      { path: "notes/result.txt", content: new TextEncoder().encode("portable") },
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
    expect(desktop.moveMouse).toHaveBeenCalledWith(100, 120);
    expect(leftClick).toHaveBeenCalledWith();
    expect(typeText).toHaveBeenCalledWith("hello");
    expect(result.observation).toMatchObject({ width: 1280, height: 800 });
    expect(command.mock.calls.some(([value]) => String(value).includes(".browser-profiles"))).toBe(
      true,
    );
    expect(command.mock.calls.some(([value]) => String(value).includes("cp -a"))).toBe(false);
    const screen = await provider.connectScreen(computer, { view: "stream" }, context);
    expect(screen.url).toBe("https://desktop.test/vnc.html");
    expect(desktop.stream.start).toHaveBeenCalledWith({ requireAuth: true });
    expect(getStreamUrl).toHaveBeenCalledWith(
      expect.objectContaining({ viewOnly: true, authKey: "screen-key" }),
    );
    expect(command).toHaveBeenCalledWith("x11vnc -R viewonly");

    const control = await provider.connectScreen(
      computer,
      { view: "stream", interactive: true, controlToken: "lease-1" },
      context,
    );
    expect(control.url).toMatch(/^https:\/\/6081-desktop\.test\/vnc\.html\?/);
    expect(command.mock.calls.some(([value]) => String(value).includes("-rfbport 5901"))).toBe(
      true,
    );

    await provider.connectScreen(computer, { view: "stream" }, context);
    const sameControl = await provider.connectScreen(
      computer,
      { view: "stream", interactive: true, controlToken: "lease-1" },
      context,
    );
    expect(sameControl.url).toBe(control.url);

    await provider.setScreenControl(computer, false, context, "lease-1");
    expect(
      command.mock.calls.some(([value]) =>
        String(value).includes("pkill -f '^x11vnc .* -rfbport 5901'"),
      ),
    ).toBe(true);
    const replacementControl = await provider.connectScreen(
      computer,
      { view: "stream", interactive: true, controlToken: "lease-2" },
      context,
    );
    expect(replacementControl.url).not.toBe(control.url);

    await provider.setScreenControl(computer, false, context, "lease-1");
    expect(command).toHaveBeenLastCalledWith(expect.stringContaining("!= 'lease-1'"));
    const stillCurrent = await provider.connectScreen(
      computer,
      { view: "stream", interactive: true, controlToken: "lease-2" },
      context,
    );
    expect(stillCurrent.url).toBe(replacementControl.url);
  });
});
