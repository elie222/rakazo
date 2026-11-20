import type { ConnectedCalendarOperation } from "@rakazo/adapter-kit";
import type { CalendarResponse } from "@rakazo/contracts";
import { CalendarOperation, CalendarResults, calendarOperationSource } from "@rakazo/contracts";
import { connectedContext } from "../integrations/connection-context.js";
import type { RunContext } from "../runs/assembly/run-context.js";
import type { ToolHandler } from "../runs/tools/run-tool-gate.js";
import { calendarWriteKey } from "./calendar-write-key.js";
import { requestNativeCalendar } from "./native-calendar.js";

async function connectedCalendar(
  ctx: RunContext,
  operation: ConnectedCalendarOperation,
): Promise<CalendarResponse> {
  const { run, thread, bot, deps } = ctx;
  const eligible =
    ctx.source.ownerStartedRun && (run.trigger !== "routine" || Boolean(run.routineId));
  if (
    !eligible ||
    run.userId !== bot.userId ||
    thread.groupId ||
    thread.externalConversationId ||
    (await ctx.trust.receivedOutsideMessage())
  )
    return { status: "unavailable" };

  const input = operation.input;
  const accountId = "calendar" in input ? input.calendar.accountId : input.accountId;
  const authorizedIds = ctx.context.connectedConnections?.map(({ id }) => id) ?? [];
  if (!authorizedIds.length || (accountId && !authorizedIds.includes(accountId)))
    return { status: "unavailable" };
  const rows = await deps.prisma.connection.findMany({
    where: {
      id: { in: accountId ? [accountId] : authorizedIds },
      userId: run.userId,
      spaceId: run.spaceId,
      status: "connected",
    },
    orderBy: { id: "asc" },
  });
  const accounts = connectedContext(rows).connectedConnections ?? [];
  const providers = accounts.flatMap((connection) => {
    const provider = deps.connectors?.managed(connection.connectorId)?.calendarProvider;
    return provider?.supportsCalendar(connection) ? [{ connection, provider }] : [];
  });
  if (operation.action !== "list_calendars" || accountId) {
    const selected = providers[0];
    if (!selected) return { status: "unavailable" };
    return selected.provider.calendar(
      selected.connection,
      operation,
      calendarWriteKey(run.id, operation),
      ctx.context,
    );
  }
  // Discovery returns account-level outcomes so an unavailable connection cannot
  // silently hide the fact that part of the list could not be read.
  const results = await Promise.all(
    providers.map(async ({ connection, provider }) => ({
      accountId: connection.id,
      accountName: connection.displayName,
      response: await provider.calendar(connection, operation, run.id, ctx.context),
    })),
  );
  const calendars = results.flatMap(({ response }) =>
    response.status === "ok" ? CalendarResults.list_calendars.parse(response.data).calendars : [],
  );
  const truncated =
    calendars.length > 200 ||
    results.some(
      ({ response }) =>
        response.status === "ok" && CalendarResults.list_calendars.parse(response.data).truncated,
    );
  return {
    status: "ok",
    data: {
      calendars: calendars.slice(0, 200),
      accounts: results.map(({ accountId, accountName, response }) => ({
        accountId,
        accountName,
        status: response.status,
      })),
      truncated,
    },
  };
}

const unavailable: CalendarResponse = { status: "unavailable" };

function outcome(result: CalendarResponse) {
  if (result.status === "ok") return result;
  const message = {
    denied: "Calendar access was denied.",
    cancelled: "The owner cancelled this calendar operation.",
    unavailable: "That calendar or reminder list is unavailable in this run.",
    unsupported: "The selected calendar cannot preserve the requested operation.",
    expired:
      "The phone did not respond before the calendar request expired. Ask the owner to open this chat on their phone and send a new message to try again.",
    uncertain:
      "The write may have been saved. Check the same calendar or list before requesting another write.",
  };
  return { ...result, error: message[result.status] };
}

export const calendarTool: ToolHandler = async (ctx, call) => {
  const parsed = CalendarOperation.safeParse({ action: call.name, input: call.args });
  if (!parsed.success)
    return call.finish({ error: parsed.error.issues[0]?.message ?? "Invalid calendar request." });
  const operation = parsed.data;
  if (calendarOperationSource(operation) === "device") {
    if (await ctx.trust.receivedOutsideMessage()) return call.finish(outcome(unavailable));
    return call.finish(
      outcome(
        await requestNativeCalendar(
          ctx.deps,
          ctx.run,
          { owner: ctx.workerId, fence: ctx.fence },
          operation,
          ctx.context.signal,
        ),
      ),
    );
  }
  if (
    operation.action === "list_calendars" ||
    operation.action === "list_calendar_events" ||
    operation.action === "create_calendar_event"
  )
    return call.finish(outcome(await connectedCalendar(ctx, operation)));
  return call.finish(outcome(unavailable));
};
