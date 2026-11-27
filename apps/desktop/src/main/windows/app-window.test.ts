import { EventEmitter } from "node:events";
import type { PathLike } from "node:fs";
import path from "node:path";
import type { Deferred } from "@rakazo/core/test-async";
import { deferred } from "@rakazo/core/test-async";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktop } from "../desktop-state.js";
import { sessionPartitionForServerUrl } from "../setup/setup-config.js";
import { PROBE_TIMEOUT_MS, resolveSessionForTarget } from "./app-window.js";

/** A hidden probe window whose navigation never finishes. */
type ProbeWindow = EventEmitter & {
  webContents: {
    executeJavaScript: ReturnType<typeof vi.fn<(script: string) => Promise<unknown>>>;
    stop: ReturnType<typeof vi.fn>;
  };
  loadURL: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
  destroy: ReturnType<typeof vi.fn<() => void>>;
};

const USER_DATA = "/tmp/rakazo-user-data";
const TARGET = "https://app.example.com/chat";
const ORIGIN = "https://app.example.com";

const state = vi.hoisted(() => {
  const partitioned = {
    kind: "partition" as const,
    cookies: { get: vi.fn(async () => [] as { name: string }[]) },
  };
  return {
    probes: [] as ProbeWindow[],
    /** Never resolves and never emits did-finish-load or did-fail-load. */
    load: undefined as Deferred<void> | undefined,
    defaultSession: { cookies: { get: vi.fn(async () => [] as { name: string }[]) } },
    partitioned,
    fromPartition: vi.fn(() => partitioned),
    existsSync: (target: PathLike) => String(target).endsWith("Local Storage"),
    writeFile: vi.fn(async () => undefined),
  };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, existsSync: (target: PathLike) => state.existsSync(target) };
});
vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, writeFile: state.writeFile };
});

vi.mock("electron", () => ({
  app: {
    getPath: () => "/tmp/rakazo-user-data",
    isPackaged: false,
    getAppPath: () => "/tmp/rakazo-app",
  },
  BrowserWindow: vi.fn(function BrowserWindow() {
    let destroyed = false;
    const probe = new EventEmitter() as ProbeWindow;
    probe.webContents = {
      executeJavaScript: vi.fn(() => new Promise(() => {})),
      stop: vi.fn(),
    };
    // The real window resolves this from did-finish-load and rejects it from did-fail-load.
    probe.loadURL = vi.fn(() => state.load?.promise ?? new Promise<void>(() => {}));
    probe.isDestroyed = () => destroyed;
    probe.destroy = vi.fn(() => {
      destroyed = true;
      probe.emit("closed");
    });
    state.probes.push(probe);
    return probe;
  }),
  Menu: { buildFromTemplate: vi.fn() },
  net: { fetch: vi.fn() },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 800, height: 600 } }) },
  session: {
    defaultSession: state.defaultSession,
    fromPartition: state.fromPartition,
  },
  shell: { openExternal: vi.fn() },
  clipboard: {},
  dialog: {},
}));
vi.mock("../system/monitoring.js", () => ({ reportDesktopError: vi.fn() }));

function track(pending: Promise<unknown>) {
  let settled = false;
  void pending.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  return () => settled;
}

async function openProbe() {
  await vi.advanceTimersByTimeAsync(0);
  expect(state.probes).toHaveLength(1);
  return state.probes[0]!;
}

function serverPartition() {
  const partition = sessionPartitionForServerUrl(TARGET);
  if (partition === null) throw new Error("expected a partition for the target");
  return partition;
}

function isolatedChoice() {
  return { partition: serverPartition(), value: state.partitioned };
}

function legacyFlagPath() {
  const partition = serverPartition().replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(USER_DATA, `legacy-default-${partition}.flag`);
}

const defaultChoice = { partition: null, value: state.defaultSession };

describe("legacy session probe", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    state.probes.length = 0;
    state.load = deferred<void>();
    state.defaultSession.cookies.get.mockReset();
    state.defaultSession.cookies.get.mockResolvedValue([]);
    state.partitioned.cookies.get.mockReset();
    state.partitioned.cookies.get.mockResolvedValue([]);
    state.fromPartition.mockClear();
    desktop.liveProbeWindows = 0;
    state.writeFile.mockClear();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("finishes a hung load within the limit and does not treat that as no legacy data", async () => {
    const pending = resolveSessionForTarget(TARGET);
    const settled = track(pending);

    const probe = await openProbe();
    expect(probe.loadURL).toHaveBeenCalledWith(ORIGIN);
    expect(desktop.liveProbeWindows).toBe(1);
    expect(settled()).toBe(false);

    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
    expect(settled()).toBe(false);
    expect(probe.destroy).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(settled()).toBe(true);
    await expect(pending).resolves.toEqual(defaultChoice);
    expect(state.partitioned.cookies.get).toHaveBeenCalledWith({ url: ORIGIN });
    expect(state.fromPartition).toHaveBeenCalledOnce();
    expect(state.fromPartition).toHaveBeenCalledWith(serverPartition());
    expect(probe.webContents.stop).toHaveBeenCalledOnce();
    expect(probe.destroy).toHaveBeenCalledOnce();
    expect(desktop.liveProbeWindows).toBe(0);
    expect(state.writeFile).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);

    // Destroying the window aborts the navigation. That rejection must stay handled.
    state.load?.reject(new Error("ERR_ABORTED"));
    await vi.advanceTimersByTimeAsync(0);
  });

  it("keeps an isolated partition that already has cookies when the probe times out", async () => {
    state.partitioned.cookies.get.mockResolvedValue([{ name: "session" }]);
    const pending = resolveSessionForTarget(TARGET);
    const settled = track(pending);
    const probe = await openProbe();

    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
    expect(settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(1);

    await expect(pending).resolves.toEqual(isolatedChoice());
    expect(state.partitioned.cookies.get).toHaveBeenCalledWith({ url: ORIGIN });
    expect(state.fromPartition).toHaveBeenCalledOnce();
    expect(state.fromPartition).toHaveBeenCalledWith(serverPartition());
    expect(state.writeFile).not.toHaveBeenCalled();
    expect(probe.webContents.stop).toHaveBeenCalledOnce();
    expect(probe.destroy).toHaveBeenCalledOnce();
    expect(desktop.liveProbeWindows).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    state.load?.reject(new Error("ERR_ABORTED"));
    await vi.advanceTimersByTimeAsync(0);
  });

  it("stays on the default session when the partition cookies cannot be read", async () => {
    state.partitioned.cookies.get.mockRejectedValue(new Error("profile locked"));
    const pending = resolveSessionForTarget(TARGET);
    await openProbe();
    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS);

    await expect(pending).resolves.toEqual(defaultChoice);
    expect(state.partitioned.cookies.get).toHaveBeenCalledWith({ url: ORIGIN });
    expect(state.writeFile).not.toHaveBeenCalled();
    expect(desktop.liveProbeWindows).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    state.load?.reject(new Error("ERR_ABORTED"));
    await vi.advanceTimersByTimeAsync(0);
  });

  it("covers a stalled storage script with the time left on the load deadline", async () => {
    const pending = resolveSessionForTarget(TARGET);
    const settled = track(pending);
    const probe = await openProbe();

    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
    expect(settled()).toBe(false);
    expect(probe.webContents.executeJavaScript).not.toHaveBeenCalled();

    state.load?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(probe.webContents.executeJavaScript).toHaveBeenCalledOnce();
    expect(settled()).toBe(false);

    // A second, fresh probe limit would still be running. One shared deadline has 1ms left.
    await vi.advanceTimersByTimeAsync(1);
    expect(settled()).toBe(true);
    await expect(pending).resolves.toEqual(defaultChoice);
    expect(state.partitioned.cookies.get).toHaveBeenCalledWith({ url: ORIGIN });
    expect(state.writeFile).not.toHaveBeenCalled();
    expect(probe.webContents.stop).toHaveBeenCalledOnce();
    expect(probe.destroy).toHaveBeenCalledOnce();
    expect(desktop.liveProbeWindows).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles a closed probe as unknown without waiting out the deadline", async () => {
    const pending = resolveSessionForTarget(TARGET);
    const settled = track(pending);
    const probe = await openProbe();

    await vi.advanceTimersByTimeAsync(PROBE_TIMEOUT_MS - 1);
    expect(settled()).toBe(false);
    probe.destroy();
    await vi.advanceTimersByTimeAsync(0);

    expect(settled()).toBe(true);
    await expect(pending).resolves.toEqual(defaultChoice);
    expect(probe.webContents.stop).not.toHaveBeenCalled();
    expect(probe.destroy).toHaveBeenCalledOnce();
    expect(state.partitioned.cookies.get).toHaveBeenCalledWith({ url: ORIGIN });
    expect(state.writeFile).not.toHaveBeenCalled();
    expect(desktop.liveProbeWindows).toBe(0);
    expect(vi.getTimerCount()).toBe(0);

    state.load?.reject(new Error("ERR_ABORTED"));
    await vi.advanceTimersByTimeAsync(0);
  });

  it("treats a refused navigation as no legacy storage", async () => {
    const pending = resolveSessionForTarget(TARGET);
    const probe = await openProbe();
    state.load?.reject(new Error("ERR_CONNECTION_REFUSED"));
    await vi.advanceTimersByTimeAsync(0);

    await expect(pending).resolves.toEqual(isolatedChoice());
    expect(state.partitioned.cookies.get).not.toHaveBeenCalled();
    expect(state.fromPartition).toHaveBeenCalledOnce();
    expect(state.writeFile).not.toHaveBeenCalled();
    expect(probe.webContents.stop).toHaveBeenCalledOnce();
    expect(probe.destroy).toHaveBeenCalledOnce();
    expect(desktop.liveProbeWindows).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("records the legacy flag when the probe finds storage", async () => {
    const pending = resolveSessionForTarget(TARGET);
    const probe = await openProbe();
    probe.webContents.executeJavaScript.mockResolvedValueOnce(true);
    state.load?.resolve();
    await vi.advanceTimersByTimeAsync(0);

    await expect(pending).resolves.toEqual(defaultChoice);
    expect(state.writeFile).toHaveBeenCalledOnce();
    expect(state.writeFile).toHaveBeenCalledWith(
      legacyFlagPath(),
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      "utf8",
    );
    expect(state.fromPartition).not.toHaveBeenCalled();
    expect(probe.destroy).toHaveBeenCalledOnce();
    expect(desktop.liveProbeWindows).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses the isolated partition when storage is empty", async () => {
    const pending = resolveSessionForTarget(TARGET);
    const probe = await openProbe();
    probe.webContents.executeJavaScript.mockResolvedValueOnce(false);
    state.load?.resolve();
    await vi.advanceTimersByTimeAsync(0);

    await expect(pending).resolves.toEqual(isolatedChoice());
    expect(state.partitioned.cookies.get).not.toHaveBeenCalled();
    expect(state.fromPartition).toHaveBeenCalledOnce();
    expect(state.writeFile).not.toHaveBeenCalled();
    expect(probe.webContents.stop).toHaveBeenCalledOnce();
    expect(probe.destroy).toHaveBeenCalledOnce();
    expect(desktop.liveProbeWindows).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
