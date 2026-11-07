// @vitest-environment jsdom
import type { Me } from "@rakazo/contracts";
import { localTimezone } from "@rakazo/core";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import type { createSpaceRpc } from "../../lib/rpc";
import { useDeviceTimezoneReport, withServerTimezone } from "./use-device-timezone-report";

type Rpc = ReturnType<typeof createSpaceRpc>;
type AdoptTimezone = (input: { timezone: string }) => Promise<Me>;

// A zone the device never runs in, so the saved one always differs from it.
const savedZone = localTimezone() === "Pacific/Auckland" ? "Europe/London" : "Pacific/Auckland";
const me = (timezone: string | null, source?: Me["timezoneSource"]) =>
  ({ timezone, timezoneSource: source }) as unknown as Me;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

/** The runtime's own zone lookup, pointed at a fixed zone for one test. */
function fakeDeviceZone(zone: string) {
  const real = Intl.DateTimeFormat;
  return vi.spyOn(Intl, "DateTimeFormat").mockImplementation(
    // A plain function, so `new` works too; a named zone canonicalizes for real, only
    // the device's own lookup answers with the fixed zone.
    ((_locale?: string, options?: Intl.DateTimeFormatOptions) => {
      if (!options?.timeZone) return { resolvedOptions: () => ({ timeZone: zone }) };
      return real("en-US", options);
    }) as unknown as typeof Intl.DateTimeFormat,
  );
}

/** Mounts the hook with a stubbed report call; `manualSave` runs the marker it returns. */
async function mountReport(adoptTimezone: AdoptTimezone, saved: Me) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const apply = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  let bump: () => void = () => {};
  function Harness({ saved }: { saved: Me }) {
    bump = useDeviceTimezoneReport(
      { preferences: { adoptTimezone } } as unknown as Rpc,
      saved,
      apply,
    );
    return null;
  }
  const rerender = async (nextSaved: Me) => {
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
  const harness = await mountReport(adoptTimezone, me(savedZone));
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
  const harness = await mountReport(adoptTimezone, me(localTimezone()));
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
  const harness = await mountReport(adoptTimezone, me(savedZone));
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
  const harness = await mountReport(adoptTimezone, me(localTimezone()));
  try {
    expect(adoptTimezone).not.toHaveBeenCalled();
    // Another device moved the account; the fresh bootstrap brings that zone.
    await harness.rerender(me(savedZone));
    expect(adoptTimezone).toHaveBeenCalledWith({ timezone: localTimezone() });
    await act(async () => answer.resolve(me(localTimezone())));
    expect(harness.apply).toHaveBeenCalledWith(me(localTimezone()));
  } finally {
    await harness.cleanup();
  }
});

it("reports again once a hand-picked zone returns to the device", async () => {
  // "Use device timezone" answers with the device source, and the helper that lands
  // a timezone answer on the cached me carries the source along, so the report guard
  // never trusts a stale "manual".
  const answer = deferred<Me>();
  const adoptTimezone = vi.fn(() => answer.promise);
  const harness = await mountReport(adoptTimezone, me(savedZone, "manual"));
  try {
    expect(adoptTimezone).not.toHaveBeenCalled();

    // The user takes the hand-picked zone back to the device; the settings save
    // applies the answer through the same helper.
    const returned = withServerTimezone(me(savedZone, "manual"), me(localTimezone(), "device"));
    expect(returned.timezoneSource).toBe("device");
    await harness.rerender(returned);
    expect(adoptTimezone).not.toHaveBeenCalled();

    // The device then moves away from that zone: the report goes out again.
    await harness.rerender(me(savedZone, returned.timezoneSource));
    expect(adoptTimezone).toHaveBeenCalledTimes(1);
    expect(adoptTimezone).toHaveBeenCalledWith({ timezone: localTimezone() });
  } finally {
    await harness.cleanup();
  }
});

it("stays quiet when the saved zone only spells the device's differently", async () => {
  const device = fakeDeviceZone("Asia/Calcutta");
  const adoptTimezone = vi.fn(async () => me("Asia/Kolkata"));
  const harness = await mountReport(adoptTimezone, me("Asia/Kolkata", "device"));
  try {
    expect(adoptTimezone).not.toHaveBeenCalled();
  } finally {
    device.mockRestore();
    await harness.cleanup();
  }
});

it("reports when only the saved zone's source turns back to the device", async () => {
  const adoptTimezone = vi.fn(async () => me(localTimezone()));
  const harness = await mountReport(adoptTimezone, me(savedZone, "manual"));
  try {
    expect(adoptTimezone).not.toHaveBeenCalled();
    // "Use device timezone" on another client: the zone stays, the source changes.
    await harness.rerender(me(savedZone, "device"));
    expect(adoptTimezone).toHaveBeenCalledWith({ timezone: localTimezone() });
  } finally {
    await harness.cleanup();
  }
});
