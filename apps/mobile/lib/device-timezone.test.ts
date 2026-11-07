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

/** Lets the report queue issue its next request before an assertion. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  vi.mocked(rpc)
    .mockReset()
    .mockImplementation(((_proc: string, body: { timezone: string }) =>
      Promise.resolve({ timezone: body.timezone })) as never);
});

describe("device timezone report", () => {
  it("reports while the server's zone differs and stays quiet once it agrees", async () => {
    const zone = fakeDeviceZone("Pacific/Auckland");
    try {
      const { reportDeviceTimeZone } = await load();
      await reportDeviceTimeZone("user-1", null);
      // The next poll's me carries the accepted zone.
      await reportDeviceTimeZone("user-1", "Pacific/Auckland");
      await reportDeviceTimeZone("user-1", "Pacific/Auckland");
      expect(vi.mocked(rpc).mock.calls).toEqual([
        ["preferences/adoptTimezone", { timezone: "Pacific/Auckland" }],
      ]);
    } finally {
      zone.mockRestore();
    }
  });

  it("reports again when the system zone changed while the app was away", async () => {
    const auckland = fakeDeviceZone("Pacific/Auckland");
    const { reportDeviceTimeZone } = await load();
    await reportDeviceTimeZone("user-1", null);
    auckland.mockRestore();
    const london = fakeDeviceZone("Europe/London");
    try {
      // The fresh me still holds the zone this device reported before the change.
      await reportDeviceTimeZone("user-1", "Pacific/Auckland");
      expect(vi.mocked(rpc).mock.calls).toEqual([
        ["preferences/adoptTimezone", { timezone: "Pacific/Auckland" }],
        ["preferences/adoptTimezone", { timezone: "Europe/London" }],
      ]);
    } finally {
      london.mockRestore();
    }
  });

  it("reports for an account signed in on this device during the same launch", async () => {
    const zone = fakeDeviceZone("Pacific/Auckland");
    try {
      const { reportDeviceTimeZone } = await load();
      // The account already agrees: quiet.
      await reportDeviceTimeZone("user-1", "Pacific/Auckland");
      await reportDeviceTimeZone("user-2", null);
      expect(vi.mocked(rpc)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(rpc).mock.calls[0]).toEqual([
        "preferences/adoptTimezone",
        { timezone: "Pacific/Auckland" },
      ]);
    } finally {
      zone.mockRestore();
    }
  });

  it("retries after a failed report and needs no extra confirmation once the server agrees", async () => {
    const zone = fakeDeviceZone("Pacific/Auckland");
    try {
      const { reportDeviceTimeZone } = await load();
      vi.mocked(rpc).mockRejectedValueOnce(new Error("offline"));
      await expect(reportDeviceTimeZone("user-1", null)).rejects.toThrow("offline");
      // The server still holds nothing: the next poll sends the report again.
      await reportDeviceTimeZone("user-1", null);
      expect(vi.mocked(rpc)).toHaveBeenCalledTimes(2);
      // The next poll's me carries the accepted zone: quiet again, without a
      // confirming send, because the comparison is against what the server holds.
      await reportDeviceTimeZone("user-1", "Pacific/Auckland");
      await reportDeviceTimeZone("user-1", "Pacific/Auckland");
      expect(vi.mocked(rpc)).toHaveBeenCalledTimes(2);
    } finally {
      zone.mockRestore();
    }
  });

  it("shares one in-flight report between identical calls", async () => {
    const zone = fakeDeviceZone("Pacific/Auckland");
    const { reportDeviceTimeZone } = await load();
    vi.mocked(rpc).mockRejectedValueOnce(new Error("offline"));
    await expect(reportDeviceTimeZone("user-1", null)).rejects.toThrow("offline");
    let settle!: () => void;
    vi.mocked(rpc).mockImplementationOnce(
      ((_proc: string, body: { timezone: string }) =>
        new Promise((resolve) => {
          settle = () => resolve({ timezone: body.timezone });
        })) as never,
    );
    try {
      const retry = reportDeviceTimeZone("user-1", null);
      const duplicate = reportDeviceTimeZone("user-1", null);
      const third = reportDeviceTimeZone("user-1", null);
      await flush();
      // The failed report and one retry: nothing more queued behind them.
      expect(vi.mocked(rpc)).toHaveBeenCalledTimes(2);
      settle();
      await Promise.all([retry, duplicate, third]);
      expect(vi.mocked(rpc)).toHaveBeenCalledTimes(2);
    } finally {
      zone.mockRestore();
    }
  });

  it("queues a newer zone behind the pending report and ends on it", async () => {
    const london = fakeDeviceZone("Europe/London");
    const { reportDeviceTimeZone } = await load();
    // The account holds whatever write the server committed last.
    let accepted: string | null = null;
    const inFlight: { accept: () => void }[] = [];
    vi.mocked(rpc).mockImplementation(
      ((_proc: string, body: { timezone: string }) =>
        new Promise((resolve) => {
          inFlight.push({
            accept: () => {
              accepted = body.timezone;
              resolve({ timezone: body.timezone });
            },
          });
        })) as never,
    );
    let auckland: ReturnType<typeof fakeDeviceZone> | undefined;
    try {
      const first = reportDeviceTimeZone("user-1", null);
      london.mockRestore();
      auckland = fakeDeviceZone("Pacific/Auckland");
      const second = reportDeviceTimeZone("user-1", null);
      // The answers land newest first, so the older write commits after the newer one.
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
      // The next poll's me carries the accepted zone: quiet.
      await reportDeviceTimeZone("user-1", "Pacific/Auckland");
      expect(vi.mocked(rpc)).toHaveBeenCalledTimes(2);
    } finally {
      london.mockRestore();
      auckland?.mockRestore();
    }
  });

  it("re-sends when a write the client gave up on lands after its successor", async () => {
    const london = fakeDeviceZone("Europe/London");
    const { reportDeviceTimeZone } = await load();
    // The account holds whatever write the server committed last; a client timeout
    // does not stop the server-side write, which can land after a newer report's.
    let accepted: string | null = null;
    type ServerCall = {
      settled: boolean;
      fail: (error: unknown) => void;
      write: (zone: string) => void;
      answer: (zone: string) => void;
    };
    const calls: ServerCall[] = [];
    vi.mocked(rpc).mockImplementation(
      ((_proc: string, _body: { timezone: string }) =>
        new Promise((resolve, reject) => {
          const call: ServerCall = {
            settled: false,
            fail: (error) => {
              call.settled = true;
              reject(error);
            },
            write: (zone) => {
              accepted = zone;
            },
            answer: (zone) => {
              call.settled = true;
              resolve({ timezone: zone });
            },
          };
          calls.push(call);
        })) as never,
    );
    /** The issued report at an index, or a throw that fails the test with how many went out. */
    const call = (index: number) => {
      const issued = calls[index];
      if (!issued) throw new Error(`report ${index} was not issued (out: ${calls.length})`);
      return issued;
    };
    /** Answers every request issued so far, as the accepted Auckland write. */
    const answerIssued = async () => {
      await flush();
      for (const current of calls) {
        if (current.settled) continue;
        current.write("Pacific/Auckland");
        current.answer("Pacific/Auckland");
        await flush();
      }
    };
    let auckland: ReturnType<typeof fakeDeviceZone> | undefined;
    try {
      const first = reportDeviceTimeZone("user-1", null);
      await flush();
      // The client gives up on the first report; its write lives on at the server.
      call(0).fail(new Error("timeout"));
      await expect(first).rejects.toThrow("timeout");
      london.mockRestore();
      auckland = fakeDeviceZone("Pacific/Auckland");
      const second = reportDeviceTimeZone("user-1", null);
      await answerIssued();
      await second;
      // The next poll's me carries the accepted zone, so nothing is left to send.
      const quiet = reportDeviceTimeZone("user-1", "Pacific/Auckland");
      await answerIssued();
      await quiet;
      // The timed-out write commits after the successor and anything that followed it.
      call(0).write("Europe/London");
      expect(accepted).toBe("Europe/London");
      // The next poll's me carries the stale zone: the device's zone goes out again.
      const third = reportDeviceTimeZone("user-1", "Europe/London");
      await answerIssued();
      await third;
      expect(accepted).toBe("Pacific/Auckland");
      // The next poll agrees: quiet.
      await reportDeviceTimeZone("user-1", "Pacific/Auckland");
      await answerIssued();
      expect(calls.length).toBe(3);
    } finally {
      london.mockRestore();
      auckland?.mockRestore();
    }
  });

  it("stays quiet while the server keeps a hand-picked zone", async () => {
    const london = fakeDeviceZone("Europe/London");
    const { reportDeviceTimeZone } = await load();
    // The server keeps the hand-picked zone against the device's report.
    vi.mocked(rpc).mockImplementationOnce(((_proc: string, _body: { timezone: string }) =>
      Promise.resolve({ timezone: "Europe/Paris" })) as never);
    let auckland: ReturnType<typeof fakeDeviceZone> | undefined;
    try {
      await reportDeviceTimeZone("user-1", null);
      london.mockRestore();
      auckland = fakeDeviceZone("Pacific/Auckland");
      // Even a moved device zone does not fight the hand-picked one.
      await reportDeviceTimeZone("user-1", "Europe/Paris");
      expect(vi.mocked(rpc)).toHaveBeenCalledTimes(1);
      // A new hand-picked zone is learned the same way: one report, refused again.
      vi.mocked(rpc).mockImplementationOnce(((_proc: string, _body: { timezone: string }) =>
        Promise.resolve({ timezone: "Europe/Berlin" })) as never);
      await reportDeviceTimeZone("user-1", "Europe/Berlin");
      expect(vi.mocked(rpc)).toHaveBeenCalledTimes(2);
      await reportDeviceTimeZone("user-1", "Europe/Berlin");
      expect(vi.mocked(rpc)).toHaveBeenCalledTimes(2);
    } finally {
      london.mockRestore();
      auckland?.mockRestore();
    }
  });

  it("stays quiet for another account whose zone the server already holds", async () => {
    const zone = fakeDeviceZone("Pacific/Auckland");
    try {
      const { reportDeviceTimeZone } = await load();
      // The first account's report lands; a second account then signs in on this
      // device, and its own zone already agrees, so no report of its own is needed.
      await reportDeviceTimeZone("user-1", null);
      await reportDeviceTimeZone("user-2", "Pacific/Auckland");
      expect(vi.mocked(rpc)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(rpc).mock.calls[0]).toEqual([
        "preferences/adoptTimezone",
        { timezone: "Pacific/Auckland" },
      ]);
    } finally {
      zone.mockRestore();
    }
  });
});
