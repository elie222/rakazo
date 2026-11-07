import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./api", () => ({ rpc: vi.fn() }));
vi.mock("./session", () => ({ currentSessionGeneration: vi.fn() }));

import { rpc } from "./api";
import { currentSessionGeneration } from "./session";

/** The session generation the mocked module reports; a sign-in bumps it. */
let generation = 0;

async function load() {
  vi.resetModules();
  return import("./device-timezone");
}

/** The runtime's own zone lookup, pointed at a fixed zone for one assertion. */
function fakeDeviceZone(zone: string) {
  const real = Intl.DateTimeFormat;
  // A named function declaration, so `new` reaches it; a named zone canonicalizes for
  // real, only the device's own lookup answers with the fixed zone.
  function lookup(_locale?: string, options?: Intl.DateTimeFormatOptions) {
    if (!options?.timeZone) return { resolvedOptions: () => ({ timeZone: zone }) };
    return real("en-US", options);
  }
  return vi
    .spyOn(Intl, "DateTimeFormat")
    .mockImplementation(lookup as unknown as typeof Intl.DateTimeFormat);
}

/** Lets the report queue issue its next request before an assertion. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  generation = 0;
  vi.mocked(currentSessionGeneration).mockImplementation(() => generation);
  vi.mocked(rpc)
    .mockReset()
    .mockImplementation(((_proc: string, body: { timezone: string }) =>
      Promise.resolve({ timezone: body.timezone })) as never);
});

describe("device timezone report", () => {
  it("reports while the account follows its devices and the server's zone differs", async () => {
    const zone = fakeDeviceZone("Pacific/Auckland");
    try {
      const { reportDeviceTimeZone } = await load();
      await reportDeviceTimeZone("user-1", null, null);
      // The next poll's me carries the accepted zone and its device source.
      await reportDeviceTimeZone("user-1", "Pacific/Auckland", "device");
      await reportDeviceTimeZone("user-1", "Pacific/Auckland", "device");
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
    await reportDeviceTimeZone("user-1", null, null);
    auckland.mockRestore();
    const london = fakeDeviceZone("Europe/London");
    try {
      // The fresh me still holds the zone this device reported before the change.
      await reportDeviceTimeZone("user-1", "Pacific/Auckland", "device");
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
      await reportDeviceTimeZone("user-1", "Pacific/Auckland", "device");
      await reportDeviceTimeZone("user-2", null, null);
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
      await expect(reportDeviceTimeZone("user-1", null, null)).rejects.toThrow("offline");
      // The server still holds nothing: the next poll sends the report again.
      await reportDeviceTimeZone("user-1", null, null);
      expect(vi.mocked(rpc)).toHaveBeenCalledTimes(2);
      // The next poll's me carries the accepted zone: quiet again, without a
      // confirming send, because the comparison is against what the server holds.
      await reportDeviceTimeZone("user-1", "Pacific/Auckland", "device");
      await reportDeviceTimeZone("user-1", "Pacific/Auckland", "device");
      expect(vi.mocked(rpc)).toHaveBeenCalledTimes(2);
    } finally {
      zone.mockRestore();
    }
  });

  it("shares one in-flight report between identical calls", async () => {
    const zone = fakeDeviceZone("Pacific/Auckland");
    const { reportDeviceTimeZone } = await load();
    vi.mocked(rpc).mockRejectedValueOnce(new Error("offline"));
    await expect(reportDeviceTimeZone("user-1", null, null)).rejects.toThrow("offline");
    let settle!: () => void;
    vi.mocked(rpc).mockImplementationOnce(
      ((_proc: string, body: { timezone: string }) =>
        new Promise((resolve) => {
          settle = () => resolve({ timezone: body.timezone });
        })) as never,
    );
    try {
      const retry = reportDeviceTimeZone("user-1", null, null);
      const duplicate = reportDeviceTimeZone("user-1", null, null);
      const third = reportDeviceTimeZone("user-1", null, null);
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
      const first = reportDeviceTimeZone("user-1", null, null);
      london.mockRestore();
      auckland = fakeDeviceZone("Pacific/Auckland");
      const second = reportDeviceTimeZone("user-1", null, null);
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
      await reportDeviceTimeZone("user-1", "Pacific/Auckland", "device");
      expect(vi.mocked(rpc)).toHaveBeenCalledTimes(2);
    } finally {
      london.mockRestore();
      auckland?.mockRestore();
    }
  });

  it("re-sends when a write the client gave up on lands before its successor's answer", async () => {
    const london = fakeDeviceZone("Europe/London");
    const { reportDeviceTimeZone } = await load();
    // The account holds whatever write the server committed last; a client timeout
    // does not stop the server-side write, which can land between a newer report's
    // write and that report's own answer read.
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
    let auckland: ReturnType<typeof fakeDeviceZone> | undefined;
    try {
      const first = reportDeviceTimeZone("user-1", null, null);
      await flush();
      // The client gives up on the first report; its write lives on at the server.
      call(0).fail(new Error("timeout"));
      await expect(first).rejects.toThrow("timeout");
      london.mockRestore();
      auckland = fakeDeviceZone("Pacific/Auckland");
      const second = reportDeviceTimeZone("user-1", null, null);
      await flush();
      // The successor's write commits, then the timed-out one, and only then does the
      // successor's answer read the account: it reports the older zone.
      call(1).write("Pacific/Auckland");
      call(0).write("Europe/London");
      call(1).answer("Europe/London");
      await second;
      expect(accepted).toBe("Europe/London");
      // The next poll's me carries the stale zone under the device source: the
      // device's zone goes out again.
      const third = reportDeviceTimeZone("user-1", "Europe/London", "device");
      await flush();
      call(2).write("Pacific/Auckland");
      call(2).answer("Pacific/Auckland");
      await third;
      expect(accepted).toBe("Pacific/Auckland");
      // The next poll agrees: quiet.
      await reportDeviceTimeZone("user-1", "Pacific/Auckland", "device");
      await flush();
      expect(calls.length).toBe(3);
    } finally {
      london.mockRestore();
      auckland?.mockRestore();
    }
  });

  it("stays quiet while the account holds a hand-picked zone", async () => {
    const zone = fakeDeviceZone("Europe/London");
    try {
      const { reportDeviceTimeZone } = await load();
      await reportDeviceTimeZone("user-1", "Pacific/Auckland", "manual");
      expect(vi.mocked(rpc)).not.toHaveBeenCalled();
      // A moved device zone does not fight the hand-picked one either.
      const paris = fakeDeviceZone("Europe/Paris");
      await reportDeviceTimeZone("user-1", "Pacific/Auckland", "manual");
      paris.mockRestore();
      expect(vi.mocked(rpc)).not.toHaveBeenCalled();
    } finally {
      zone.mockRestore();
    }
  });

  it("reports again after a hand-picked zone returns to the device", async () => {
    const auckland = fakeDeviceZone("Pacific/Auckland");
    const { reportDeviceTimeZone } = await load();
    // The server keeps the hand-picked zone against the device's report.
    vi.mocked(rpc).mockImplementationOnce(((_proc: string, _body: { timezone: string }) =>
      Promise.resolve({ timezone: "Europe/London" })) as never);
    let london: ReturnType<typeof fakeDeviceZone> | undefined;
    let paris: ReturnType<typeof fakeDeviceZone> | undefined;
    try {
      await reportDeviceTimeZone("user-1", "Europe/London", "manual");
      auckland.mockRestore();
      // The user returns the account to the device on another client: this device's
      // report lands again.
      london = fakeDeviceZone("Europe/London");
      await reportDeviceTimeZone("user-1", "Pacific/Auckland", "device");
      expect(vi.mocked(rpc)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(rpc).mock.calls[0]?.[1]).toEqual({ timezone: "Europe/London" });
      // The account and this device agree: quiet.
      await reportDeviceTimeZone("user-1", "Europe/London", "device");
      expect(vi.mocked(rpc)).toHaveBeenCalledTimes(1);
      // A later move reports again, with nothing remembered about the manual choice.
      london.mockRestore();
      paris = fakeDeviceZone("Europe/Paris");
      await reportDeviceTimeZone("user-1", "Europe/London", "device");
      expect(vi.mocked(rpc)).toHaveBeenCalledTimes(2);
      expect(vi.mocked(rpc).mock.calls[1]?.[1]).toEqual({ timezone: "Europe/Paris" });
    } finally {
      auckland.mockRestore();
      london?.mockRestore();
      paris?.mockRestore();
    }
  });

  it("drops a queued report when another sign-in takes the session before it runs", async () => {
    const zone = fakeDeviceZone("Pacific/Auckland");
    const { reportDeviceTimeZone } = await load();
    try {
      const first = reportDeviceTimeZone("user-1", null, null);
      // The account switches before the queued report runs.
      generation = 1;
      await flush();
      expect(vi.mocked(rpc)).not.toHaveBeenCalled();
      await first;
      // Signing back in as the same account reports the same zone again.
      generation = 2;
      await reportDeviceTimeZone("user-1", null, null);
      expect(vi.mocked(rpc)).toHaveBeenCalledTimes(1);
    } finally {
      zone.mockRestore();
    }
  });

  it("stays quiet when the server spells the device's zone differently", async () => {
    const zone = fakeDeviceZone("Asia/Calcutta");
    try {
      const { reportDeviceTimeZone } = await load();
      await reportDeviceTimeZone("user-1", "Asia/Kolkata", "device");
      await reportDeviceTimeZone("user-1", "Asia/Calcutta", "device");
      expect(vi.mocked(rpc)).not.toHaveBeenCalled();
    } finally {
      zone.mockRestore();
    }
  });

  it("keeps reporting on a zone difference when an older server cannot say the source", async () => {
    const zone = fakeDeviceZone("Europe/Paris");
    try {
      const { reportDeviceTimeZone } = await load();
      await reportDeviceTimeZone("user-1", "Europe/London", undefined);
      expect(vi.mocked(rpc)).toHaveBeenCalledTimes(1);
      // Once that server holds the zone, the next poll is quiet.
      await reportDeviceTimeZone("user-1", "Europe/Paris", undefined);
      expect(vi.mocked(rpc)).toHaveBeenCalledTimes(1);
    } finally {
      zone.mockRestore();
    }
  });
});
