import type * as HarnessModule from "@rakazo/adapters/host-harness";
import { DesktopHarness } from "@rakazo/adapters/host-harness";
import type { BrowserWindow, WebContents } from "electron";
import { app, dialog, net } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prepareDesktopHarness } from "./host-harness.js";
import type { IpcCaller } from "./ipc/ipc.js";
import { handleIpc } from "./ipc/ipc.js";

const harness = vi.hoisted(() => ({
  profiles: vi.fn(),
  selection: vi.fn(),
  configure: vi.fn(),
  send: vi.fn(),
  answer: vi.fn(),
  stop: vi.fn(),
  disconnectedWindow: vi.fn(),
  hasRuns: vi.fn(),
  close: vi.fn(),
}));
const appOn = vi.hoisted(() =>
  vi.fn<(name: string, listener: (event: unknown, contents: WebContents) => void) => void>(),
);
vi.mock("@rakazo/adapters/host-harness", async (actual) => ({
  ...(await actual<typeof HarnessModule>()),
  DesktopHarness: vi.fn(
    class {
      constructor() {
        Object.assign(this, harness);
      }
    },
  ),
}));
vi.mock("electron", () => ({
  app: { on: appOn, quit: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showMessageBox: vi.fn(), showErrorBox: vi.fn() },
  net: { fetch: vi.fn() },
}));
vi.mock("./i18n.js", () => ({ t: (text: string) => text }));
vi.mock("./ipc.js", () => ({ handleIpc: vi.fn() }));

beforeEach(() => {
  vi.clearAllMocks();
  harness.hasRuns.mockReturnValue(false);
  harness.close.mockResolvedValue(undefined);
});

function fixture() {
  let origin: string | null = "https://product.example.test";
  let window: BrowserWindow | null = null;
  const onQuitFailure = vi.fn();
  const beforeQuit = prepareDesktopHarness({
    root: "fixture-workspace",
    currentOrigin: () => origin,
    originForEvent: () => origin,
    mainWindow: () => window,
    onQuitFailure,
  });
  return {
    beforeQuit,
    onQuitFailure,
    setOrigin: (value: string | null) => {
      origin = value;
    },
    setWindow: (value: BrowserWindow | null) => {
      window = value;
    },
    options: vi.mocked(DesktopHarness).mock.calls[0]![0],
    invoke(method: string, input: unknown) {
      const handler = vi
        .mocked(handleIpc)
        .mock.calls.find(([name]) => name === `desktop.harness.${method}`)![1];
      return handler({} as IpcCaller, input);
    },
  };
}

describe("desktop harness boundary", () => {
  it("denies untrusted frames before parsing input or invoking native authority", async () => {
    const f = fixture();
    f.setOrigin(null);
    expect(await f.invoke("profiles", null)).toEqual([]);
    expect(await f.invoke("selection", null)).toBeNull();
    expect(await f.invoke("answer", null)).toBe(false);
    expect(await f.invoke("stop", null)).toBeUndefined();
    expect(await f.invoke("disconnect", null)).toBeUndefined();
    await expect(f.invoke("send", {})).rejects.toThrow("Local agent unavailable");
    await expect(f.invoke("configure", {})).rejects.toThrow("Local agent unavailable");
    for (const method of [
      "profiles",
      "selection",
      "answer",
      "stop",
      "disconnectedWindow",
      "send",
      "configure",
    ] as const)
      expect(harness[method]).not.toHaveBeenCalled();
  });

  it("validates trusted IPC and rejects injected launch parameters", async () => {
    const f = fixture();
    const scope = { spaceId: "space", botId: "bot" };
    const message = { ...scope, text: "  Do the task  ", clientNonce: "message" };
    await expect(f.invoke("send", { ...message, argv: ["untrusted-command"] })).rejects.toThrow();
    expect(harness.send).not.toHaveBeenCalled();
    await f.invoke("send", message);
    expect(harness.send).toHaveBeenCalledWith("https://product.example.test", {
      ...message,
      text: "Do the task",
    });
    await expect(f.invoke("disconnect", { unexpected: true })).rejects.toThrow();
    expect(harness.disconnectedWindow).not.toHaveBeenCalled();
    await f.invoke("disconnect", {});
    expect(harness.disconnectedWindow).toHaveBeenCalledOnce();
  });

  it("uses the main window's authenticated session and bypasses custom protocol handlers", async () => {
    const f = fixture();
    const sessionFetch = vi.fn();
    f.setWindow({
      isDestroyed: () => false,
      webContents: { session: { fetch: sessionFetch } },
    } as unknown as BrowserWindow);
    await f.options.fetch(new URL("https://product.example.test/rpc"), { method: "POST" });
    expect(sessionFetch).toHaveBeenCalledWith("https://product.example.test/rpc", {
      method: "POST",
      bypassCustomProtocolHandlers: true,
    });
    expect(net.fetch).not.toHaveBeenCalled();
    f.setWindow(null);
    await f.options.fetch("https://product.example.test/rpc");
    expect(net.fetch).toHaveBeenCalledWith("https://product.example.test/rpc", {
      bypassCustomProtocolHandlers: true,
    });
  });

  it("requires native consent and defaults to cancel", async () => {
    const f = fixture();
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] });
    expect(await f.options.chooseDirectory()).toBeNull();
    vi.mocked(dialog.showMessageBox).mockResolvedValue({ response: 1, checkboxChecked: false });
    expect(
      await f.options.confirm({
        origin: "https://product.example.test",
        workspace: "fixture-workspace",
        target: "workspace",
      }),
    ).toBe(false);
    expect(dialog.showMessageBox).toHaveBeenCalledWith(
      expect.objectContaining({ defaultId: 1, cancelId: 1 }),
    );
  });

  it("revokes only when the main frame actually navigates away", () => {
    const f = fixture();
    const contents = { on: vi.fn() };
    f.setWindow({ webContents: contents } as unknown as BrowserWindow);
    const created = appOn.mock.calls.find(([name]) => name === "web-contents-created")![1];
    created({}, contents as unknown as WebContents);
    const navigate = contents.on.mock.calls[0]![1];
    navigate({}, "https://product.example.test", true, true);
    navigate({}, "https://product.example.test", false, false);
    expect(harness.disconnectedWindow).not.toHaveBeenCalled();
    navigate({}, "https://product.example.test/next", false, true);
    expect(harness.disconnectedWindow).toHaveBeenCalledOnce();
  });

  it("holds quit until cleanup succeeds before allowing other teardown", async () => {
    const f = fixture();
    const event = { preventDefault: vi.fn() };
    expect(f.beforeQuit(event)).toBe(false);
    expect(event.preventDefault).not.toHaveBeenCalled();
    harness.hasRuns.mockReturnValue(true);
    let finish!: () => void;
    harness.close.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
    );
    expect(f.beforeQuit(event)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();
    finish();
    await vi.waitFor(() => expect(app.quit).toHaveBeenCalledOnce());
    expect(f.onQuitFailure).not.toHaveBeenCalled();
  });

  it("keeps the app open if native cleanup cannot be confirmed", async () => {
    const f = fixture();
    harness.hasRuns.mockReturnValue(true);
    harness.close.mockRejectedValue(new Error("cleanup_failed"));
    expect(f.beforeQuit({ preventDefault: vi.fn() })).toBe(true);
    await vi.waitFor(() => expect(f.onQuitFailure).toHaveBeenCalledOnce());
    expect(dialog.showErrorBox).toHaveBeenCalledOnce();
    expect(app.quit).not.toHaveBeenCalled();
  });
});
