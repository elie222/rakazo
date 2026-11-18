import type { MeetingProvider } from "@rakazo/adapter-kit";

export async function configuredMeetingProvider(
  source = process.env,
): Promise<MeetingProvider | undefined> {
  const provider = source.MEETING_PROVIDER?.trim();
  if (!provider) return;
  if (provider === "emulator") {
    if (source.NODE_ENV === "production") throw new Error("The meeting emulator is for local use");
    const { MeetingEmulator } = await import("./meeting-emulator.js");
    return new MeetingEmulator();
  }
  if (provider !== "recall") throw new Error("Unknown meeting provider");
  const { RecallMeetingProvider } = await import("../providers/meeting/recall/recall-meeting.js");
  const apiKey = source.MEETING_API_KEY?.trim();
  const secret = source.MEETING_WEBHOOK_SECRET?.trim();
  const region = source.MEETING_REGION?.trim();
  const prefix = source.MEETING_WEBHOOK_SIGNATURE?.trim() ?? "webhook";
  if (
    !apiKey ||
    !secret?.startsWith("whsec_") ||
    !region ||
    !["us-east-1", "us-west-2", "eu-central-1", "ap-northeast-1"].includes(region) ||
    (prefix !== "webhook" && prefix !== "svix")
  ) {
    throw new Error("The meeting provider needs a region, API key, and webhook signing secret");
  }
  return new RecallMeetingProvider({
    origin: `https://${region}.recall.ai`,
    apiKey,
    verification: { secret, prefix },
  });
}

export function configuredMeetingSpaces(provider: MeetingProvider, source = process.env) {
  if (provider.describe().capabilities.offline) return undefined;
  return new Set(
    source.MEETING_SPACE_IDS?.split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );
}
