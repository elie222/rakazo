// @vitest-environment jsdom
import type { Me } from "@rakazo/contracts";
import { localTimezone } from "@rakazo/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { createSpaceRpc } from "../../lib/rpc";
import { useDeviceTimezoneReport } from "./use-device-timezone-report";

type Rpc = ReturnType<typeof createSpaceRpc>;
type AdoptTimezone = (input: { timezone: string }) => Promise<Me>;

// A zone the device never runs in, so the saved one always differs from it.
const savedZone = localTimezone() === "Pacific/Auckland" ? "Europe/London" : "Pacific/Auckland";
const me = (timezone: string | null) => ({ timezone }) as unknown as Me;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** Mounts the hook with a stubbed report call; `manualSave` runs the marker it returns. */
async function mountReport(adoptTimezone: AdoptTimezone, saved: string | null) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const apply = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let bump: () => void = () => {};
  function Harness({ saved }: { saved: string | null }) {
    bump = useDeviceTimezoneReport(
      { preferences: { adoptTimezone } } as unknown as Rpc,
      me(saved),
      apply,
    );
    return null;
  }
  const rerender = async (nextSaved: string | null) => {
    await act(async () => root.render(<Harness saved={nextSaved} />));
  };
  await rerender(saved);
  return {
    apply,
    manualSave: bump,
    rerender,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

it("reports the device zone while the saved one differs and applies the answer", async () => {
  const answer = deferred<Me>();
  const adoptTimezone = vi.fn(() => answer.promise);
  const harness = await mountReport(adoptTimezone, savedZone);
  try {
    expect(adoptTimezone).toHaveBeenCalledWith({ timezone: localTimezone() });
    await act(async () => answer.resolve(me(localTimezone())));
    expect(harness.apply).toHaveBeenCalledWith(me(localTimezone()));
  } finally {
    await harness.cleanup();
  }
});

it("stays quiet while the saved zone equals the device's", async () => {
  const adoptTimezone = vi.fn(async () => me(savedZone));
  const harness = await mountReport(adoptTimezone, localTimezone());
  try {
    expect(adoptTimezone).not.toHaveBeenCalled();
    expect(harness.apply).not.toHaveBeenCalled();
  } finally {
    await harness.cleanup();
  }
});

it("a delayed report answer never repaints a newer manual save", async () => {
  const answer = deferred<Me>();
  const adoptTimezone = vi.fn(() => answer.promise);
  const harness = await mountReport(adoptTimezone, savedZone);
  try {
    // The report is in flight when the user's manual save commits and paints Settings.
    await act(async () => harness.manualSave());
    // The stale answer arrives after it: the chosen zone stays on screen.
    await act(async () => answer.resolve(me(localTimezone())));
    expect(harness.apply).not.toHaveBeenCalled();
  } finally {
    await harness.cleanup();
  }
});

it("a fresh bootstrap zone after a matching cached seed still reports", async () => {
  const answer = deferred<Me>();
  const adoptTimezone = vi.fn(() => answer.promise);
  // The cached seed paints this device's zone, so the shell starts quiet.
  const harness = await mountReport(adoptTimezone, localTimezone());
  try {
    expect(adoptTimezone).not.toHaveBeenCalled();
    // Another device moved the account; the fresh bootstrap brings that zone.
    await harness.rerender(savedZone);
    expect(adoptTimezone).toHaveBeenCalledWith({ timezone: localTimezone() });
    await act(async () => answer.resolve(me(localTimezone())));
    expect(harness.apply).toHaveBeenCalledWith(me(localTimezone()));
  } finally {
    await harness.cleanup();
  }
});
