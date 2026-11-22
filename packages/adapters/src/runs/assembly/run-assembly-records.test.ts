import { describe, expect, it, vi } from "vitest";
import { connectRun, runHistoryReach } from "./run-assembly-records.js";

type ConnectRunInput = Parameters<typeof connectRun>;

describe("connecting a run", () => {
  it("does not leave a failed tool discovery unhandled when a setup step throws before it is awaited", async () => {
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      const hold = {
        deps: {
          events: { append: async () => undefined },
          // A vi.fn rejection is observed by the spy itself and could never go unhandled.
          connector: { discoverTools: () => Promise.reject(new Error("discovery failed")) },
        },
        run: { spaceId: "space-1", userId: "user-1", trigger: "user", routineId: null },
        runId: "run-1",
        fence: 1,
        computerLease: null,
        lease: { valid: true },
        abort: { controller: null },
      } as unknown as ConnectRunInput[1];
      const records = {
        bot: { id: "bot-1" },
        thread: { id: "thread-1" },
        configuredMemory: null,
        storedConnections: [],
      } as unknown as ConnectRunInput[2]["records"];

      const connected = await connectRun(
        { executorDeps: {} } as unknown as ConnectRunInput[0],
        hold,
        { records },
      );
      // The steps that read history run here; one of them throwing leaves discovery unawaited.
      await new Promise((resolve) => setImmediate(resolve));

      expect(unhandled).not.toHaveBeenCalled();
      // The step that does await discovery still fails setup with its error.
      await expect(connected.discoveredPromise).rejects.toThrow("discovery failed");
    } finally {
      process.off("unhandledRejection", unhandled);
    }
  });
});

describe("runHistoryReach", () => {
  it("reads a silent routine's chat as any routine's: recent alongside, all in the chat", () => {
    for (const trigger of ["routine", "silent_routine"]) {
      expect(runHistoryReach({ trigger, routine: { inChat: false } })).toBe("recent");
      expect(runHistoryReach({ trigger, routine: { inChat: true } })).toBe("all");
      expect(runHistoryReach({ trigger, routine: null })).toBe("none");
    }
  });
});
