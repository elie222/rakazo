// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useLiveStream, useRosterSignals, useSpaceChanges } from "./roster-signals";

const streams = vi.hoisted(
  () =>
    [] as Array<{
      signal: () => void;
      change: (kind: string) => void;
      organizations: () => void;
      end: () => void;
      fail: (error: unknown) => void;
    }>,
);
const computerUpdates = vi.hoisted(() => ({ signalled: vi.fn() }));
vi.mock("./computer-updates", () => ({ computerUpdates }));
const organizations = vi.hoisted(() => ({ refreshOrganizationReads: vi.fn() }));
vi.mock("./organizations", () => organizations);
const spaceSelection = vi.hoisted(() => new Set<() => void>());
vi.mock("./api", () => ({
  subscribeSpaceSelection: (listener: () => void) => {
    spaceSelection.add(listener);
    return () => spaceSelection.delete(listener);
  },
}));

const sessionChanges = vi.hoisted(() => new Set<() => void>());
vi.mock("./session", () => ({
  subscribeSessionGeneration: (listener: () => void) => {
    sessionChanges.add(listener);
    return () => sessionChanges.delete(listener);
  },
}));

vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return appState.current;
    },
    addEventListener: (_event: string, listener: () => void) => {
      appState.listeners.add(listener);
      return { remove: () => appState.listeners.delete(listener) };
    },
  },
}));

vi.mock("./api-live", () => ({
  subscribeRosterSignals: (
    onSignal: () => void,
    signal: AbortSignal,
    onSpaceChange: (kind: string) => void,
    onOrganizationsChange: () => void,
  ) =>
    new Promise<void>((resolve, reject) => {
      streams.push({
        signal: onSignal,
        change: onSpaceChange,
        organizations: onOrganizationsChange,
        end: resolve,
        fail: reject,
      });
      signal.addEventListener("abort", () => resolve());
    }),
}));

const appState = vi.hoisted(() => ({
  current: "active",
  listeners: new Set<() => void>(),
  set(next: string) {
    this.current = next;
    for (const listener of this.listeners) listener();
  },
}));
function Harness({ onChange, enabled }: { onChange: () => void; enabled: boolean }) {
  useRosterSignals(onChange, enabled);
  return null;
}
function Changes({ kind, onChange }: { kind: "runs" | "routines"; onChange: () => void }) {
  useSpaceChanges(kind, onChange, true);
  return null;
}
function Stream() {
  useLiveStream(true);
  return null;
}

describe("useRosterSignals", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    // Retry and reconnect waits are jittered; pin them to their unjittered values.
    vi.spyOn(Math, "random").mockReturnValue(0);
    vi.useFakeTimers();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    streams.length = 0;
    vi.clearAllMocks();
    appState.current = "active";
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("reads once when shown, then on every signal and never on a timer", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<Harness enabled onChange={onChange} />));
    expect(streams).toHaveLength(1);
    expect(onChange).toHaveBeenCalledTimes(1);
    await act(async () => streams[0]!.signal());
    await act(async () => streams[0]!.signal());
    expect(onChange).toHaveBeenCalledTimes(3);
    await act(() => vi.advanceTimersByTimeAsync(10 * 60_000));
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("re-reads on the opening signal of a reconnect", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<Harness enabled onChange={onChange} />));
    await act(async () => streams[0]!.signal());
    await act(async () => streams[0]!.end());
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(streams).toHaveLength(2);
    expect(onChange).toHaveBeenCalledTimes(2);
    await act(async () => streams[1]!.signal());
    expect(onChange).toHaveBeenCalledTimes(3);
  });

  it("re-reads when the app returns to the foreground", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<Harness enabled onChange={onChange} />));
    await act(async () => appState.set("background"));
    expect(onChange).toHaveBeenCalledTimes(1);
    await act(async () => appState.set("active"));
    expect(onChange).toHaveBeenCalledTimes(2);
  });

  it("passes computer update signals on", async () => {
    await act(async () => root.render(<Harness enabled onChange={vi.fn()} />));
    await act(async () => streams[0]!.change("computerUpdates"));
    expect(computerUpdates.signalled).toHaveBeenCalledOnce();
  });

  it("re-reads organizations on their signal", async () => {
    await act(async () => root.render(<Stream />));
    await act(async () => streams[0]!.organizations());
    expect(organizations.refreshOrganizationReads).toHaveBeenCalledOnce();
  });

  it("holds the stream and reads on each change of its own kind", async () => {
    const runs = vi.fn();
    const routines = vi.fn();
    await act(async () =>
      root.render(
        <>
          <Changes kind="runs" onChange={runs} />
          <Changes kind="routines" onChange={routines} />
        </>,
      ),
    );
    expect(streams).toHaveLength(1);
    await act(async () => streams[0]!.change("runs"));
    await act(async () => streams[0]!.change("runs"));
    expect(runs).toHaveBeenCalledTimes(2);
    expect(routines).not.toHaveBeenCalled();
    await act(async () => streams[0]!.change("routines"));
    expect(routines).toHaveBeenCalledOnce();
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(runs).toHaveBeenCalledTimes(2);
  });

  it("reads again when the app returns to the foreground", async () => {
    const runs = vi.fn();
    await act(async () => root.render(<Changes kind="runs" onChange={runs} />));
    await act(async () => appState.set("background"));
    expect(runs).not.toHaveBeenCalled();
    await act(async () => appState.set("active"));
    expect(runs).toHaveBeenCalledOnce();
  });

  it("shares one stream, held open by the update progress off the inbox", async () => {
    const onChange = vi.fn();
    await act(async () =>
      root.render(
        <>
          <Stream />
          <Harness enabled={false} onChange={onChange} />
        </>,
      ),
    );
    await act(async () => streams[0]!.signal());
    expect(onChange).not.toHaveBeenCalled();
    const other = vi.fn();
    await act(async () =>
      root.render(
        <>
          <Stream />
          <Harness enabled onChange={onChange} />
          <Harness enabled onChange={other} />
        </>,
      ),
    );
    expect(streams).toHaveLength(1);
    expect(onChange).toHaveBeenCalledOnce();
    await act(async () => streams[0]!.signal());
    expect(onChange).toHaveBeenCalledTimes(2);
    expect(other).toHaveBeenCalledTimes(2);
  });

  it("reopens for a newly selected Space, ignoring the old stream's late signals", async () => {
    await act(async () => root.render(<Harness enabled onChange={vi.fn()} />));
    const old = streams[0]!;
    await act(async () => {
      for (const listener of spaceSelection) listener();
    });
    expect(streams).toHaveLength(2);
    await act(async () => old.change("computerUpdates"));
    expect(computerUpdates.signalled).not.toHaveBeenCalled();
    expect(spaceSelection.size).toBe(1);
  });

  it("after a refusal, waits for another session or Space instead of asking again", async () => {
    await act(async () => root.render(<Harness enabled onChange={vi.fn()} />));
    await act(async () => streams[0]!.fail(Object.assign(new Error("Forbidden"), { status: 403 })));
    await act(() => vi.advanceTimersByTimeAsync(60_000));
    expect(streams).toHaveLength(1);
    await act(async () => {
      for (const listener of spaceSelection) listener();
    });
    expect(streams).toHaveLength(2);
  });

  it("reopens under a new session", async () => {
    await act(async () => root.render(<Harness enabled onChange={vi.fn()} />));
    await act(async () => {
      for (const listener of sessionChanges) listener();
    });
    expect(streams).toHaveLength(2);
    expect(sessionChanges.size).toBe(1);
  });

  it("stays closed while disabled", async () => {
    await act(async () => root.render(<Harness enabled={false} onChange={vi.fn()} />));
    expect(streams).toHaveLength(0);
  });
});
