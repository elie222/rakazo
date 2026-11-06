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

  it("retries after a failed report, so a blip cannot pin the account to UTC", async () => {
    const zone = fakeDeviceZone("Pacific/Auckland");
    try {
      const { reportDeviceTimeZone } = await load();
      vi.mocked(rpc).mockRejectedValueOnce(new Error("offline"));
      await expect(reportDeviceTimeZone("user-1")).rejects.toThrow("offline");
      // The next poll or foreground return sends the report again.
      await reportDeviceTimeZone("user-1");
      expect(vi.mocked(rpc)).toHaveBeenCalledTimes(2);
      // A success after the retry keeps later calls quiet again.
      await reportDeviceTimeZone("user-1");
      expect(vi.mocked(rpc)).toHaveBeenCalledTimes(2);
    } finally {
      zone.mockRestore();
    }
  });

  it("keeps the newer zone when it changes while a report is in flight", async () => {
    const london = fakeDeviceZone("Europe/London");
    const { reportDeviceTimeZone } = await load();
    // The account holds whatever report the server accepted last.
    let accepted: string | null = null;
    const inFlight: { accept: () => void }[] = [];
    vi.mocked(rpc).mockImplementation(
      ((_proc: string, body: { timezone: string }) =>
        new Promise<void>((resolve) => {
          inFlight.push({
            accept: () => {
              accepted = body.timezone;
              resolve();
            },
          });
        })) as never,
    );
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    let auckland: ReturnType<typeof fakeDeviceZone> | undefined;
    try {
      const first = reportDeviceTimeZone("user-1");
      london.mockRestore();
      auckland = fakeDeviceZone("Pacific/Auckland");
      const second = reportDeviceTimeZone("user-1");
      // Answers land newest first, so the older write commits after the newer one.
      let drained = false;
      void Promise.all([first, second]).then(() => {
        drained = true;
      });
      while (!drained) {
        await flush();
        inFlight.pop()?.accept();
      }
      await first;
      await second;
      expect(accepted).toBe("Pacific/Auckland");
      // A later poll must not stay quiet while the account holds an older zone.
      await reportDeviceTimeZone("user-1");
      expect(accepted).toBe("Pacific/Auckland");
    } finally {
      london.mockRestore();
      auckland?.mockRestore();
      vi.mocked(rpc)
        .mockReset()
        .mockResolvedValue({} as never);
    }
  });

  it("stays quiet while a report is still in flight", async () => {
    const zone = fakeDeviceZone("Pacific/Auckland");
    try {
      const { reportDeviceTimeZone } = await load();
      let resolve!: () => void;
      vi.mocked(rpc).mockReturnValueOnce(
        new Promise<void>((settle) => {
          resolve = settle;
        }) as never,
      );
      const first = reportDeviceTimeZone("user-1");
      const duplicate = reportDeviceTimeZone("user-1");
      await duplicate;
      expect(vi.mocked(rpc)).toHaveBeenCalledTimes(1);
      resolve();
      await first;
    } finally {
      zone.mockRestore();
    }
  });
});
