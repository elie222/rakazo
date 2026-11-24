import { appContract } from "@rakazo/contracts";
import { toolEffectIdempotencyKey } from "@rakazo/core/node/approval-effect-key";
import type { PrismaClient, RunLease, ThreadEvents } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { requestNativeCalendar } from "../personal-calendar/native-calendar.js";
import { phoneClockTool } from "./run-phone-clock-tool.js";

vi.mock("@rakazo/db", async (original) => ({
  ...(await original<typeof import("@rakazo/db")>()),
  assertRunCanWriteHistory: vi.fn(),
  runAsSystem: (_label: string, work: () => unknown) => work(),
}));

it("keeps a device proof on an atomic private message and Routine send", () => {
  const key = "01234567-89ab-4cde-8fab-0123456789ab";
  expect(
    appContract.threads.sendWithRoutines["~orpc"].inputSchema!.parse({
      botId: "bot",
      clientNonce: "message",
      routineIds: ["routine"],
      text: "Set a timer",
      nativeClockDeviceKey: key,
    }).nativeClockDeviceKey,
  ).toBe(key);
});

const operation = { action: "start_phone_timer", input: { durationSeconds: 60 } } as const;
const run = { id: "run", userId: "owner", spaceId: "space", threadId: "thread" };
const lease = { owner: "worker", fence: 1 } as RunLease;
const key = (occurrence = 0) =>
  toolEffectIdempotencyKey(run.id, operation.action, operation.input, occurrence);

function store() {
  type Row = {
    id: string;
    sessionId: string;
    deviceDigest: string;
    status: string;
    result: unknown;
    expiresAt: Date;
  };
  const rows = new Map<string, Row>();
  const runQuery = {
    findFirst: vi.fn().mockResolvedValue({
      id: run.id,
      sourceMessage: { nativeCalendarSessionId: "session", nativeClockDeviceDigest: "device" },
    }),
  };
  const tx = {
    run: runQuery,
    nativeCalendarRequest: {
      findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
      findFirst: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
      createMany: vi.fn(async ({ data }: { data: Row }) => {
        const status = rows.size === 0 ? "dispatched" : "cancelled";
        rows.set(data.id, { ...data, status: "finished", result: { status } });
        return { count: 1 };
      }),
    },
  };
  const prisma = {
    run: runQuery,
    session: { findFirst: async () => ({ id: "session" }) },
    $transaction: (work: (fixture: typeof tx) => unknown) => work(tx),
  } as unknown as PrismaClient;
  const events = {
    publishSpaceChange: vi.fn(),
    followSpaceChanges: vi.fn(),
  } as unknown as ThreadEvents;
  return { deps: { prisma, events }, rows, runQuery, create: tx.nativeCalendarRequest.createMany };
}

it("reuses the same Clock occurrence without collapsing a separately approved identical timer", async () => {
  const fixture = store();
  const clock = (effectKey: string) =>
    requestNativeCalendar(
      fixture.deps,
      run,
      lease,
      operation,
      new AbortController().signal,
      effectKey,
    );
  await expect(clock(key())).resolves.toEqual({ status: "dispatched" });
  await expect(clock(key())).resolves.toEqual({ status: "dispatched" });
  await expect(clock(key(1))).resolves.toEqual({ status: "cancelled" });
  await expect(clock(key(1))).resolves.toEqual({ status: "cancelled" });
  expect([...fixture.rows.keys()]).toEqual([key(), key(1)]);
  expect(fixture.create).toHaveBeenCalledTimes(2);
});

it.each([
  "",
  "malformed",
  key().replace(/^run:/, "other-run:"),
  key().replace(operation.action, "set_phone_alarm"),
])("fails closed before DB access with an invalid Clock effect key", async (effectKey) => {
  const fixture = store();
  await expect(
    requestNativeCalendar(
      fixture.deps,
      run,
      lease,
      operation,
      new AbortController().signal,
      effectKey,
    ),
  ).resolves.toEqual({ status: "unavailable" });
  expect(fixture.runQuery.findFirst).not.toHaveBeenCalled();
});

it("passes the gate's occurrence-aware effect key from the real tool handler", async () => {
  const fixture = store();
  const ctx = {
    deps: fixture.deps,
    run,
    workerId: lease.owner,
    fence: lease.fence,
    context: { signal: new AbortController().signal },
    trust: { receivedOutsideMessage: async () => false },
  } as unknown as Parameters<typeof phoneClockTool>[0];
  const call = {
    name: operation.action,
    args: operation.input,
    effectKey: key(1),
    finish: async (result: unknown) => result,
  } as Parameters<typeof phoneClockTool>[1];
  await expect(phoneClockTool(ctx, call)).resolves.toMatchObject({ status: "dispatched" });
  expect([...fixture.rows.keys()]).toEqual([key(1)]);
});
