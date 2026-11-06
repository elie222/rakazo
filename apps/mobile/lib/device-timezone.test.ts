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
      // The failed report may still commit, so one later poll confirms the zone.
      await reportDeviceTimeZone("user-1");
      expect(vi.mocked(rpc)).toHaveBeenCalledTimes(3);
      expect(vi.mocked(rpc).mock.calls[2]).toEqual([
        "preferences/adoptTimezone",
        { timezone: "Pacific/Auckland" },
      ]);
      // A success after the confirmation keeps later calls quiet again.
      await reportDeviceTimeZone("user-1");
      expect(vi.mocked(rpc)).toHaveBeenCalledTimes(3);
    } finally {
      zone.mockRestore();
    }
  });

  it("re-sends the zone when a timed-out report commits after its successor", async () => {
    const london = fakeDeviceZone("Europe/London");
    const { reportDeviceTimeZone } = await load();
    // The account holds whatever write the server committed last; a client timeout does
    // not stop the server-side write, which can land after a newer report's.
    let accepted: string | null = null;
    const calls: {
      timezone: string;
      write: () => void;
      succeed: () => void;
      fail: (error: unknown) => void;
    }[] = [];
    vi.mocked(rpc).mockImplementation(
      ((_proc: string, body: { timezone: string }) =>
        new Promise<void>((resolve, reject) => {
          calls.push({
            timezone: body.timezone,
            write: () => {
              accepted = body.timezone;
            },
            succeed: () => resolve(),
            fail: (error) => reject(error),
          });
        })) as never,
    );
    const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
    /** The issued report at an index, or a throw that fails the test with how many went out. */
    const call = (index: number) => {
      const issued = calls[index];
      if (!issued) throw new Error(`report ${index} was not issued (out: ${calls.length})`);
      return issued;
    };
    let auckland: ReturnType<typeof fakeDeviceZone> | undefined;
    try {
      const first = reportDeviceTimeZone("user-1");
      london.mockRestore();
      auckland = fakeDeviceZone("Pacific/Auckland");
      const second = reportDeviceTimeZone("user-1");
      await flush();
      expect(call(0).timezone).toBe("Europe/London");
      // The client gives up on the first report; its write lives on at the server.
      call(0).fail(new Error("timeout"));
      await expect(first).rejects.toThrow("timeout");
      await flush();
      expect(call(1).timezone).toBe("Pacific/Auckland");
      call(1).succeed();
      call(1).write();
      await second;
      // The timed-out write commits after the successor's.
      call(0).write();
      expect(accepted).toBe("Europe/London");
      // The next poll must re-send the device's zone instead of staying quiet.
      const third = reportDeviceTimeZone("user-1");
      await flush();
      expect(call(2).timezone).toBe("Pacific/Auckland");
      call(2).succeed();
      call(2).write();
      await third;
      expect(accepted).toBe("Pacific/Auckland");
      // The confirmed zone keeps later polls quiet again.
      await reportDeviceTimeZone("user-1");
      await flush();
      expect(calls.length).toBe(3);
    } finally {
      london.mockRestore();
      auckland?.mockRestore();
      vi.mocked(rpc)
        .mockReset()
        .mockResolvedValue({} as never);
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
