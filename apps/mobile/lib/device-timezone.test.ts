import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({ rpc: vi.fn() }));

import { rpc } from "./api";

async function load() {
  vi.resetModules();
  return import("./device-timezone");
}

/** The runtime's own zone lookup, pointed at a fixed zone for one assertion. */
function fakeDeviceZone(zone: string) {
  return vi.spyOn(Intl, "DateTimeFormat").mockImplementation((() => ({
    resolvedOptions: () => ({ timeZone: zone }),
  })) as unknown as typeof Intl.DateTimeFormat);
}

beforeEach(() => {
  vi.mocked(rpc)
    .mockReset()
    .mockResolvedValue({} as never);
});

describe("device timezone report", () => {
  it("reports the zone once per account and launch: polls and foreground returns stay quiet", async () => {
    const zone = fakeDeviceZone("Pacific/Auckland");
    try {
      const { reportDeviceTimeZone } = await load();
      await reportDeviceTimeZone("user-1");
      await reportDeviceTimeZone("user-1");
      await reportDeviceTimeZone("user-1");
      expect(vi.mocked(rpc).mock.calls).toEqual([
        ["preferences/adoptTimezone", { timezone: "Pacific/Auckland" }],
      ]);
    } finally {
      zone.mockRestore();
    }
  });

  it("reports again when the system zone changed while the app was away", async () => {
    const london = fakeDeviceZone("Europe/London");
    const { reportDeviceTimeZone } = await load();
    await reportDeviceTimeZone("user-1");
    london.mockRestore();
    const auckland = fakeDeviceZone("Pacific/Auckland");
    try {
      await reportDeviceTimeZone("user-1");
      expect(vi.mocked(rpc).mock.calls).toEqual([
        ["preferences/adoptTimezone", { timezone: "Europe/London" }],
        ["preferences/adoptTimezone", { timezone: "Pacific/Auckland" }],
      ]);
    } finally {
      auckland.mockRestore();
    }
  });

  it("reports for an account signed in on this device during the same launch", async () => {
    const zone = fakeDeviceZone("Pacific/Auckland");
    try {
      const { reportDeviceTimeZone } = await load();
      await reportDeviceTimeZone("user-1");
      await reportDeviceTimeZone("user-2");
      expect(vi.mocked(rpc)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(rpc).mock.calls[1]).toEqual([
        "preferences/adoptTimezone",
        { timezone: "Pacific/Auckland" },
      ]);
    } finally {
      zone.mockRestore();
    }
  });
});
