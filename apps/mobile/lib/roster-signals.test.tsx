// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRosterSignals } from "./roster-signals";

const streams = vi.hoisted(
  () => [] as Array<{ signal: () => void; computerUpdates: () => void; end: () => void }>,
);
const computerUpdateSignals = vi.hoisted(() => ({ signalled: vi.fn(), lost: vi.fn() }));
const computerUpdates = vi.hoisted(() => ({ connect: () => computerUpdateSignals }));
vi.mock("./computer-updates", () => ({ computerUpdates }));
const spaceSelection = vi.hoisted(() => new Set<() => void>());
vi.mock("./api", () => ({
  subscribeSpaceSelection: (listener: () => void) => {
    spaceSelection.add(listener);
    return () => spaceSelection.delete(listener);
  },
}));

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
}));

vi.mock("./api-live", () => ({
  subscribeRosterSignals: (
    onSignal: () => void,
    signal: AbortSignal,
    onComputerUpdates: () => void,
  ) =>
    new Promise<void>((resolve) => {
      streams.push({ signal: onSignal, computerUpdates: onComputerUpdates, end: resolve });
      signal.addEventListener("abort", () => resolve());
    }),
}));

let live = false;
function Harness({ onChange, enabled }: { onChange: () => void; enabled: boolean }) {
  live = useRosterSignals(onChange, enabled);
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
    live = false;
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

  it("goes live on the first signal and reloads on each one after it", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<Harness enabled onChange={onChange} />));
    expect(streams).toHaveLength(1);
    await act(async () => streams[0]!.signal());
    expect(live).toBe(true);
    expect(onChange).not.toHaveBeenCalled();
    await act(async () => streams[0]!.signal());
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("drops back to polling when the stream ends, then reconnects", async () => {
    const onChange = vi.fn();
    await act(async () => root.render(<Harness enabled onChange={onChange} />));
    await act(async () => streams[0]!.signal());
    await act(async () => streams[0]!.end());
    expect(live).toBe(false);
    await act(() => vi.advanceTimersByTimeAsync(1_000));
    expect(streams).toHaveLength(2);
  });

  it("passes computer update signals on, and their loss when the stream ends", async () => {
    await act(async () => root.render(<Harness enabled onChange={vi.fn()} />));
    await act(async () => streams[0]!.computerUpdates());
    expect(computerUpdateSignals.signalled).toHaveBeenCalledOnce();
    expect(computerUpdateSignals.lost).not.toHaveBeenCalled();
    await act(async () => streams[0]!.end());
    expect(computerUpdateSignals.lost).toHaveBeenCalledOnce();
  });

  it("reopens for a newly selected Space, ignoring the old stream's late signals", async () => {
    await act(async () => root.render(<Harness enabled onChange={vi.fn()} />));
    const old = streams[0]!;
    await act(async () => {
      for (const listener of spaceSelection) listener();
    });
    expect(streams).toHaveLength(2);
    expect(computerUpdateSignals.lost).toHaveBeenCalledOnce();
    await act(async () => old.computerUpdates());
    expect(computerUpdateSignals.signalled).not.toHaveBeenCalled();
    expect(spaceSelection.size).toBe(1);
  });

  it("stays closed while disabled", async () => {
    await act(async () => root.render(<Harness enabled={false} onChange={vi.fn()} />));
    expect(streams).toHaveLength(0);
  });
});
