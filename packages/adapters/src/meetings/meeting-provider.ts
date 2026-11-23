import type { MeetingCalendarProvider, MeetingProvider } from "@rakazo/adapter-kit";

/** Select transports here; meeting and calendar services receive only their interfaces. */
export async function configuredMeetingProviders(source = process.env): Promise<{
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
  return configuredRecallMeeting(source);
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
