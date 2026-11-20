import { createHash, randomUUID } from "node:crypto";
import type {
  Actor,
  CalendarOperation as Operation,
  NativeCalendarRequest as Request,
  CalendarResponse as Response,
} from "@rakazo/contracts";
import {
  CalendarOperation,
  CalendarResponse,
  CalendarResults,
  calendarOperationSource,
  NATIVE_CALENDAR_WINDOW_MS,
} from "@rakazo/contracts";
import { deadlineSignal } from "@rakazo/core";
import type { NativeCalendarRequest, PrismaClient, RunLease, ThreadEvents } from "@rakazo/db";
import {
  assertRunCanWriteHistory,
  JsonColumnMismatchError,
  Prisma,
  readJsonColumn,
  reportJsonColumnOnce,
  runAsSystem,
} from "@rakazo/db";
import { calendarWriteKey } from "./calendar-write-key.js";

type Store = Pick<PrismaClient, "run" | "nativeCalendarRequest">;
type Session = Pick<Actor, "spaceId" | "userId"> & { sessionId: string };
type Device = Session & { deviceDigest: string };

export const nativeCalendarDeviceDigest = (key: string) =>
  createHash("sha256").update(key).digest("hex");

type RequestId = Pick<Request, "id" | "runId" | "threadId">;

export async function pruneExpiredNativeCalendarRequests(store: Store, now: Date) {
  // A running or resumable turn still needs its write record to prevent another save.
  const { count } = await runAsSystem("prune finished phone calendar requests", () =>
    store.nativeCalendarRequest.deleteMany({
      where: {
        expiresAt: { lte: now },
        run: { status: { in: ["completed", "failed", "cancelled"] } },
      },
      limit: 1_000,
    }),
  );
  return count;
}

export function nativeCalendarScope({ spaceId, userId, sessionId }: Session) {
  return `native-calendar:${createHash("sha256")
    .update(JSON.stringify([spaceId, userId, sessionId]))
    .digest("hex")}`;
}

/** One-to-one chats in a shared Space are readable by other members. */
function privateRun(userId: string): Prisma.RunWhereInput {
  return {
    userId,
    status: "running",
    leaseOwner: { not: null },
    leaseExpiresAt: { gt: new Date() },
    trigger: "user",
    routineId: null,
    delegatedFromRunId: null,
    thread: {
      userId,
      botId: { not: null },
      helperBotId: null,
      groupId: null,
      externalConversationId: null,
      bot: { userId, archivedAt: null },
      space: {
        deletingAt: null,
        memberships: { some: { userId }, every: { userId } },
        organization: { members: { every: { userId } } },
      },
    },
  };
}

function ownSource(session: Device, threadId?: string): Prisma.RunWhereInput {
  const { sessionId, userId, deviceDigest } = session;
  return {
    ...privateRun(userId),
    sourceMessage: {
      threadId,
      role: "user",
      authorUserId: userId,
      nativeCalendarSessionId: sessionId,
      nativeCalendarDeviceDigest: deviceDigest,
    },
    steeringMessages: {
      none: {
        message: {
          OR: [
            { nativeCalendarSessionId: null },
            { nativeCalendarSessionId: { not: sessionId } },
            { nativeCalendarDeviceDigest: null },
            { nativeCalendarDeviceDigest: { not: deviceDigest } },
          ],
        },
      },
    },
  };
}

function requestWhere(session: Device, request: RequestId): Prisma.NativeCalendarRequestWhereInput {
  return {
    ...session,
    id: request.id,
    runId: request.runId,
    expiresAt: { gt: new Date() },
    run: { ...ownSource(session, request.threadId), threadId: request.threadId },
  };
}

function requestDto(row: NativeCalendarRequest, threadId: string): Request {
  return {
    id: row.id,
    runId: row.runId,
    threadId,
    remainingMs: Math.min(
      NATIVE_CALENDAR_WINDOW_MS,
      Math.max(0, row.expiresAt.getTime() - Date.now()),
    ),
    operation: readJsonColumn(
      CalendarOperation,
      row.operation,
      {
        table: "native_calendar_requests",
        column: "operation",
        id: row.id,
      },
      "reject",
    ),
  };
}

export async function pendingNativeCalendar(store: Store, session: Device, botId: string) {
  const rows = await store.nativeCalendarRequest.findMany({
    where: {
      ...session,
      status: "pending",
      expiresAt: { gt: new Date() },
      run: { ...ownSource(session), botId },
    },
    include: { run: { select: { threadId: true } } },
    orderBy: { expiresAt: "asc" },
    take: 8,
  });
  return rows.flatMap((row) => {
    try {
      return [requestDto(row, row.run.threadId)];
    } catch (error) {
      if (!(error instanceof JsonColumnMismatchError)) throw error;
      reportJsonColumnOnce("Invalid native calendar request", error.row);
      return [];
    }
  });
}

export async function claimNativeCalendar(store: Store, session: Device, request: RequestId) {
  const where = { ...requestWhere(session, request), status: "pending" };
  const row = await store.nativeCalendarRequest.findFirst({ where });
  if (!row) return null;
  const payload = requestDto(row, request.threadId);
  const claimed = await store.nativeCalendarRequest.updateMany({
    where,
    data: { status: "claimed" },
  });
  return claimed.count === 1 ? payload : null;
}

export async function finishNativeCalendar(
  deps: { prisma: Store; events: ThreadEvents },
  session: Device,
  request: RequestId,
  response: Response,
) {
  const where = { ...requestWhere(session, request), status: "claimed" };
  const row = await deps.prisma.nativeCalendarRequest.findFirst({ where });
  if (!row) return false;
  if (response.status === "ok") {
    const operation = requestDto(row, request.threadId).operation;
    const parsed = CalendarResults[operation.action].safeParse(response.data);
    if (!parsed.success || !matchesNativeTarget(operation, parsed.data)) return false;
    response = { status: "ok", data: parsed.data };
  }
  const updated = await deps.prisma.nativeCalendarRequest.updateMany({
    where: { ...where, id: request.id },
    data: {
      status: "finished",
      operation: Prisma.DbNull,
      result: response as Prisma.InputJsonValue,
    },
  });
  if (!updated.count) return false;
  await deps.events.publishSpaceChange?.(nativeCalendarScope(session), "nativeCalendar");
  return true;
}

function matchesNativeTarget(operation: Operation, data: unknown) {
  switch (operation.action) {
    case "create_calendar_event": {
      const result = CalendarResults.create_calendar_event.parse(data);
      const { calendar } = operation.input;
      return (
        result.calendar.source === calendar.source &&
        result.calendar.accountId === calendar.accountId &&
        result.calendar.calendarId === calendar.calendarId
      );
    }
    case "create_reminder":
    case "complete_reminder": {
      const result = CalendarResults[operation.action].parse(data);
      const { list } = operation.input;
      return (
        result.list.accountId === list.accountId &&
        result.list.listId === list.listId &&
        (operation.action !== "complete_reminder" || result.id === operation.input.reminderId)
      );
    }
    case "list_calendar_events": {
      const { calendar } = operation.input;
      const { events } = CalendarResults.list_calendar_events.parse(data);
      return events.every(
        ({ calendar: item }) =>
          item.source === calendar.source &&
          item.accountId === calendar.accountId &&
          item.calendarId === calendar.calendarId,
      );
    }
    case "list_calendars": {
      const { accountId } = operation.input;
      return CalendarResults.list_calendars
        .parse(data)
        .calendars.every(
          (calendar) =>
            calendar.source === "device" && (!accountId || calendar.accountId === accountId),
        );
    }
    case "list_reminders": {
      const { list } = operation.input;
      const { lists, reminders } = CalendarResults.list_reminders.parse(data);
      return list
        ? lists.length === 1 &&
            lists[0]?.accountId === list.accountId &&
            lists[0]?.listId === list.listId
        : !reminders;
    }
  }
}

export function isCalendarWrite(action: Operation["action"]) {
  return (
    action === "create_calendar_event" ||
    action === "create_reminder" ||
    action === "complete_reminder"
  );
}

export async function requestNativeCalendar(
  { prisma, events }: { prisma: PrismaClient; events: ThreadEvents },
  run: { id: string; userId: string; spaceId: string; threadId: string },
  lease: RunLease,
  operation: Operation,
  parent: AbortSignal,
): Promise<Response> {
  if (calendarOperationSource(operation) !== "device") return { status: "unavailable" };
  const { id: runId, userId, spaceId, threadId } = run;
  const owner = await prisma.run.findFirst({
    where: {
      ...privateRun(userId),
      id: runId,
      spaceId,
      threadId,
      sourceMessage: {
        threadId,
        role: "user",
        authorUserId: userId,
        nativeCalendarSessionId: { not: null },
      },
    },
    select: {
      sourceMessage: {
        select: { nativeCalendarSessionId: true, nativeCalendarDeviceDigest: true },
      },
    },
  });
  const sessionId = owner?.sourceMessage?.nativeCalendarSessionId;
  const deviceDigest = owner?.sourceMessage?.nativeCalendarDeviceDigest;
  if (!sessionId || !deviceDigest || !events.publishSpaceChange || !events.followSpaceChanges)
    return { status: "unavailable" };
  const live = await runAsSystem("verify the originating calendar session", () =>
    prisma.session.findFirst({
      where: { id: sessionId, userId, expiresAt: { gt: new Date() } },
      select: { id: true },
    }),
  );
  if (!live) return { status: "unavailable" };
  const session = { spaceId, userId, sessionId, deviceDigest };
  const write = isCalendarWrite(operation.action);
  const id = write ? calendarWriteKey(runId, operation) : randomUUID();
  const row = await prisma.$transaction(async (tx) => {
    await assertRunCanWriteHistory(tx, runId, { lease });
    if (
      !(await tx.run.findFirst({
        where: { ...ownSource(session, threadId), id: runId },
        select: { id: true },
      }))
    )
      return null;
    const existing = await tx.nativeCalendarRequest.findUnique({ where: { id } });
    if (existing) {
      return existing.sessionId === sessionId && existing.deviceDigest === deviceDigest
        ? existing
        : null;
    }
    await tx.nativeCalendarRequest.createMany({
      skipDuplicates: true,
      data: {
        ...session,
        id,
        runId,
        operation,
        status: "pending",
        expiresAt: new Date(Date.now() + NATIVE_CALENDAR_WINDOW_MS),
      },
    });
    return tx.nativeCalendarRequest.findFirst({ where: { id, sessionId, deviceDigest } });
  });
  if (!row) return { status: "unavailable" };

  const readResult = (current: NativeCalendarRequest) =>
    current.status === "finished" && current.result
      ? readJsonColumn(
          CalendarResponse,
          current.result,
          { table: "native_calendar_requests", column: "result", id },
          "reject",
        )
      : undefined;
  const terminal = readResult(row);
  if (terminal) return terminal;
  const expired: Response = { status: write && row.status === "claimed" ? "uncertain" : "expired" };
  if (row.expiresAt.getTime() <= Date.now()) return expired;
  const signal = deadlineSignal(Math.max(1, row.expiresAt.getTime() - Date.now()), parent);
  const scope = nativeCalendarScope(session);
  await events.publishSpaceChange(scope, "nativeCalendar");
  try {
    // The subscription emits an initial signal after attaching. A reply before it
    // attaches is covered by that first read.
    for await (const change of events.followSpaceChanges(scope, signal)) {
      if (change !== "nativeCalendar") continue;
      const current = await prisma.nativeCalendarRequest.findUnique({ where: { id } });
      if (!current) return { status: "unavailable" };
      const result = readResult(current);
      if (result) return result;
    }
  } catch (error) {
    if (!signal.aborted) throw error;
  }
  parent.throwIfAborted();
  const final = await prisma.nativeCalendarRequest.findUnique({ where: { id } });
  if (!final) return { status: "unavailable" };
  return (
    readResult(final) ?? { status: write && final.status === "claimed" ? "uncertain" : "expired" }
  );
}
