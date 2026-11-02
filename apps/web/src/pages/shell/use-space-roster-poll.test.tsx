// @vitest-environment jsdom
import type { Bot } from "@rakazo/contracts";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({ useLingui: () => ({ t: vi.fn() }) }));

vi.mock("../../lib/bootstrap", () => ({ takeInitialBootstrap: () => new Promise(() => {}) }));

import { useSpaceBootstrap } from "./use-space-roster";

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function fixture() {
  vi.useFakeTimers();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("Notification", { permission: "granted" });
  Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
  const refreshBots = vi.fn().mockResolvedValue(undefined);
  const callsEnabledRef = { current: false };
  function Harness({ enabled }: { enabled: boolean }) {
    useSpaceBootstrap({
      roster: {
        bots: [{ id: "agent", notifyOnFinish: enabled } as Bot],
        groups: [],
        botSections: [],
        archivedBots: [],
        archivedGroups: [],
        spaces: [],
        callsEnabledRef,
        refreshBots,
        botsRefreshApplied: { current: 0 },
        botsRefreshInFlight: { current: 0 },
        routeBotId: { current: undefined },
        routeGroupId: { current: undefined },
      },
      thread: { snapshotRef: { current: null } },
    } as never);
    return null;
  }
  return { refreshBots, callsEnabledRef, Harness, root: createRoot(document.createElement("div")) };
}

it("skips hidden rosters without enabled notifications and uses the latest settings at a slower cadence", async () => {
  const { root, Harness, refreshBots } = fixture();
  try {
    await act(async () => root.render(<Harness enabled={false} />));
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(refreshBots).not.toHaveBeenCalled();
    await act(async () => root.render(<Harness enabled />));
    await act(async () => vi.advanceTimersByTimeAsync(3_100));
    expect(refreshBots).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(27_000));
    expect(refreshBots).toHaveBeenCalledTimes(1);
    await act(async () => vi.advanceTimersByTimeAsync(3_000));
    expect(refreshBots).toHaveBeenCalledTimes(2);
    await act(async () => root.render(<Harness enabled={false} />));
    await act(async () => vi.advanceTimersByTimeAsync(30_000));
    expect(refreshBots).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
  }
});

it("preserves the visible and call-enabled polling cadence", async () => {
  const { root, Harness, refreshBots, callsEnabledRef } = fixture();
  Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
  try {
    await act(async () => root.render(<Harness enabled={false} />));
    await act(async () => vi.advanceTimersByTimeAsync(6_100));
    expect(refreshBots).toHaveBeenCalledTimes(2);
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    vi.stubGlobal("Notification", { permission: "denied" });
    callsEnabledRef.current = true;
    await act(async () => vi.advanceTimersByTimeAsync(6_000));
    expect(refreshBots).toHaveBeenCalledTimes(4);
  } finally {
    await act(async () => root.unmount());
  }
});
