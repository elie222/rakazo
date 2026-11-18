import type { MeetingCalendarProvider, MeetingProvider } from "@rakazo/adapter-kit";

/** Calendar capability is installed separately from the meeting transport. */
export async function configuredMeetingCalendar(
  meeting: MeetingProvider | undefined,
  source = process.env,
): Promise<MeetingCalendarProvider | undefined> {
  if (!meeting) return;
  const id = meeting.describe().id;
  if (id === "emulator" && source.NODE_ENV !== "production") {
    const { RecallCalendarEmulator } = await import(
      "../../providers/meeting/recall/calendar-emulator.js"
    );
    return new RecallCalendarEmulator().provider;
  }
  if (id !== "recall") return;
  const oauthClientId = source.MEETING_CALENDAR_CLIENT_ID?.trim();
  const oauthClientSecret = source.MEETING_CALENDAR_CLIENT_SECRET?.trim();
  if (!oauthClientId && !oauthClientSecret) return;
  if (!oauthClientId || !oauthClientSecret) {
    throw new Error("The meeting calendar needs an OAuth client ID and secret");
  }
  const apiKey = source.MEETING_API_KEY?.trim();
  const secret =
    source.MEETING_CALENDAR_WEBHOOK_SECRET?.trim() || source.MEETING_WEBHOOK_SECRET?.trim();
  const region = source.MEETING_REGION?.trim();
  const prefix = source.MEETING_WEBHOOK_SIGNATURE?.trim() ?? "webhook";
  if (
    !apiKey ||
    !secret?.startsWith("whsec_") ||
    !region ||
    (prefix !== "webhook" && prefix !== "svix")
  ) {
    throw new Error("The meeting calendar needs a configured meeting provider");
  }
  const { RecallCalendarProvider } = await import(
    "../../providers/meeting/recall/calendar-provider.js"
  );
  const { verifyRecallSignature } = await import(
    "../../providers/meeting/recall/recall-meeting.js"
  );
  return new RecallCalendarProvider({
    baseUrl: `https://${region}.recall.ai`,
    apiKey,
    oauthClientId,
    oauthClientSecret,
    verify: (body, headers) => verifyRecallSignature({ secret, prefix }, body, headers),
  });
}
