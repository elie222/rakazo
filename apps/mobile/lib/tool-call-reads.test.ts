import { describe, expect, it, vi } from "vitest";

const sessionCaches = vi.hoisted(() => [] as Array<() => void>);
vi.mock("./session", () => ({
  registerSessionDiskCache: (clear: () => void) => sessionCaches.push(clear),
}));

const { readFinishedRunToolCalls } = await import("./tool-call-reads");

const done = (executionId: string) => ({ executionId, name: "shell", status: "done" as const });

describe("readFinishedRunToolCalls", () => {
  it("reads a finished run once for all its steps and forgets on sign-out", async () => {
    const read = vi.fn(async () => [done("x1"), done("x2")]);
    await readFinishedRunToolCalls("run-1", "x1", read);
    await readFinishedRunToolCalls("run-1", "x2", read);
    expect(read).toHaveBeenCalledOnce();
    for (const clear of sessionCaches) clear();
    await readFinishedRunToolCalls("run-1", "x1", read);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it("reads again after a failure, or when the read was taken mid-run", async () => {
    const failing = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue([done("x1")]);
    await expect(readFinishedRunToolCalls("run-2", "x1", failing)).rejects.toThrow("offline");
    await expect(readFinishedRunToolCalls("run-2", "x1", failing)).resolves.toEqual([done("x1")]);
    expect(failing).toHaveBeenCalledTimes(2);

    const midRun = vi
      .fn()
      .mockResolvedValueOnce([{ ...done("x1"), status: "running" }])
      .mockResolvedValue([done("x1"), done("x2")]);
    await readFinishedRunToolCalls("run-3", "x1", midRun);
    // The cached read still had a running call, and lacks the later one: read again.
    await expect(readFinishedRunToolCalls("run-3", "x2", midRun)).resolves.toHaveLength(2);
    expect(midRun).toHaveBeenCalledTimes(2);
  });
});
