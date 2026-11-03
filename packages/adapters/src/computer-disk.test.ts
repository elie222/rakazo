import type {
  AdapterContext,
  ComputerRef,
  ProcessEvent,
  SandboxProvider,
} from "@rakazo/adapter-kit";
import { describe, expect, it } from "vitest";
import {
  diskNoteInstruction,
  diskUsedPercent,
  measureComputerDisk,
  parseDf,
} from "./computer-disk.js";

const DF = `Filesystem     1024-blocks     Used Available Capacity Mounted on
/dev/vda1         82045336 75000000   7045336      92% /home/rakazo
`;
const GiB = 1024n ** 3n;
const context = { signal: new AbortController().signal } as AdapterContext;

function sandbox(events: ProcessEvent[] | Error) {
  const argv: string[][] = [];
  return {
    argv,
    provider: {
      async *execute(_computer: ComputerRef, request: { argv: string[] }) {
        argv.push(request.argv);
        if (events instanceof Error) throw events;
        yield* events;
      },
    } as unknown as SandboxProvider,
  };
}

describe("computer disk", () => {
  it("reads used and free space from df", () => {
    expect(parseDf(DF)).toEqual({
      diskUsedBytes: 75000000n * 1024n,
      diskFreeBytes: 7045336n * 1024n,
    });
    expect(diskUsedPercent(parseDf(DF)!)).toBe(92);
    expect(parseDf("df: .: No such file or directory")).toBeUndefined();
    expect(parseDf("")).toBeUndefined();
  });

  it("measures Linux computers and skips the user's own", async () => {
    const linux = sandbox([
      { type: "stdout", data: DF },
      { type: "exit", code: 0 },
    ]);
    const ref = { id: "c", botId: "b", providerRef: "p" };
    expect(await measureComputerDisk(linux.provider, { ...ref, kind: "docker" }, context)).toEqual(
      parseDf(DF),
    );
    expect(linux.argv).toEqual([["df", "-Pk", "."]]);
    expect(await measureComputerDisk(linux.provider, { ...ref, kind: "desktop" }, context)).toBe(
      undefined,
    );
    const failing = sandbox(new Error("gone"));
    expect(await measureComputerDisk(failing.provider, { ...ref, kind: "docker" }, context)).toBe(
      undefined,
    );
    const refused = sandbox([{ type: "exit", code: 1 }]);
    expect(await measureComputerDisk(refused.provider, { ...ref, kind: "docker" }, context)).toBe(
      undefined,
    );
  });

  it("tells the bot only once the disk is 85% full", () => {
    expect(diskNoteInstruction({ diskUsedBytes: 84n * GiB, diskFreeBytes: 16n * GiB })).toBe(
      undefined,
    );
    expect(diskNoteInstruction({ diskUsedBytes: null, diskFreeBytes: null })).toBe(undefined);
    expect(diskNoteInstruction({ diskUsedBytes: 72n * GiB, diskFreeBytes: 8n * GiB })).toBe(
      "The computer's disk is 90% full (9 GB free). Free space by removing build output and caches you no longer need, or tell the user.",
    );
    expect(
      diskNoteInstruction({ diskUsedBytes: 80n * GiB, diskFreeBytes: 500_000_000n }),
    ).toContain("100% full (500 MB free)");
  });
});
