import type {
  MeetingCalendarAccountStore,
  MeetingCalendarProvider,
  MeetingProvider,
} from "@rakazo/adapter-kit";

/** Select transports here; meeting and calendar services receive only their interfaces. */
export async function configuredMeetingProviders(
  source = process.env,
  /** Sealed accounts of password sign-in calendars, required by `MEETING_CALENDAR_PROVIDER=caldav`. */
  calendarAccounts?: MeetingCalendarAccountStore,
): Promise<{
  meeting?: MeetingProvider;
  calendar?: MeetingCalendarProvider;
}> {
  const provider = source.MEETING_PROVIDER?.trim();
  if (!provider) return {};
  if (provider === "emulator") {
    if (source.NODE_ENV === "production") throw new Error("The meeting emulator is for local use");
    const [{ MeetingEmulator }, { RecallCalendarEmulator }] = await Promise.all([
      import("../providers/meeting/emulator/meeting-emulator.js"),
      import("../providers/meeting/recall/calendar-emulator.js"),
    ]);
    return { meeting: new MeetingEmulator(), calendar: new RecallCalendarEmulator().provider };
  }
  if (provider !== "recall") throw new Error("Unknown meeting provider");
  const { configuredRecallMeeting } = await import("../providers/meeting/recall/configuration.js");
  const recall = await configuredRecallMeeting(source);
  if (!("scheduledBots" in recall) || !recall.scheduledBots) return recall;
  if (!calendarAccounts) throw new Error("The CalDAV calendar needs account storage");
  const [{ CalDavCalendarProvider }, { createSafeRemoteFetch }] = await Promise.all([
    import("../providers/meeting/caldav/caldav-calendar-provider.js"),
    import("../mcp/remote-mcp.js"),
  ]);
  // Members choose the server, so it gets the same address checks as remote connectors.
  const safeFetch = createSafeRemoteFetch(undefined, undefined, {
    allowPrivateEndpoint: source.MCP_ALLOW_PRIVATE_ENDPOINT === "true",
  });
  const calendar = new CalDavCalendarProvider({
    accounts: calendarAccounts,
    bots: recall.scheduledBots,
    fetch: (url, init) => safeFetch(url, init),
  });
  return { meeting: recall.meeting, calendar };
}

export function configuredMeetingSpaces(provider: MeetingProvider, source = process.env) {
  if (provider.describe().capabilities.offline || source.MEETING_SPACE_IDS?.trim() === "*") {
    return undefined;
  }
  return new Set(
    source.MEETING_SPACE_IDS?.split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}
