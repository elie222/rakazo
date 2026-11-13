// @vitest-environment jsdom

import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRosterSignals } from "./roster-signals";

const streams = vi.hoisted(() => [] as Array<{ signal: () => void; end: () => void }>);

vi.mock("react-native", () => ({
  AppState: { currentState: "active", addEventListener: () => ({ remove: () => {} }) },
}));

vi.mock("./api-live", () => ({
  subscribeRosterSignals: (onSignal: () => void, signal: AbortSignal) =>
    new Promise<void>((resolve) => {
      streams.push({ signal: onSignal, end: resolve });
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

  it("stays closed while disabled", async () => {
    await act(async () => root.render(<Harness enabled={false} onChange={vi.fn()} />));
    expect(streams).toHaveLength(0);
  });
});
