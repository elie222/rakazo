import { RecallMeetingProvider, verifyRecallSignature } from "./recall-meeting.js";

export async function configuredRecallMeeting(source: NodeJS.ProcessEnv) {
  const apiKey = source.MEETING_API_KEY?.trim();
  const secret = source.MEETING_WEBHOOK_SECRET?.trim();
  const region = source.MEETING_REGION?.trim();
  const prefix = source.MEETING_WEBHOOK_SIGNATURE?.trim() || "webhook";
  if (
    !apiKey ||
    !secret?.startsWith("whsec_") ||
    !region ||
    !["us-east-1", "us-west-2", "eu-central-1", "ap-northeast-1"].includes(region) ||
    (prefix !== "webhook" && prefix !== "svix")
  ) {
    throw new Error("The meeting provider needs a region, API key, and webhook signing secret");
  }
  const origin = `https://${region}.recall.ai`;
  const meeting = new RecallMeetingProvider({ origin, apiKey, verification: { secret, prefix } });

  const oauthClientId = source.MEETING_CALENDAR_CLIENT_ID?.trim();
  const oauthClientSecret = source.MEETING_CALENDAR_CLIENT_SECRET?.trim();
  if (!oauthClientId && !oauthClientSecret) return { meeting };
  if (!oauthClientId || !oauthClientSecret) {
    throw new Error("The meeting calendar needs an OAuth client ID and secret");
  }
  const calendarSecret = source.MEETING_CALENDAR_WEBHOOK_SECRET?.trim() || secret;
  if (!calendarSecret.startsWith("whsec_")) {
    throw new Error("The meeting calendar needs a webhook signing secret");
  }
  const { RecallCalendarProvider } = await import("./calendar-provider.js");
  const calendar = new RecallCalendarProvider({
    baseUrl: origin,
    apiKey,
    oauthClientId,
    oauthClientSecret,
    verify: (body, headers) =>
      verifyRecallSignature({ secret: calendarSecret, prefix }, body, headers),
  });
  return { meeting, calendar };
}
