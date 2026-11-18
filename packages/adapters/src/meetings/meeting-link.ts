import { ClientError } from "@rakazo/core";
import { googleMeetLink } from "../providers/meeting-link/google-meet/google-meet-link.js";
import { microsoftTeamsLink } from "../providers/meeting-link/microsoft-teams/microsoft-teams-link.js";
import { zoomMeetingLink } from "../providers/meeting-link/zoom/zoom-link.js";

const meetingLinkRecognizers = [googleMeetLink, zoomMeetingLink, microsoftTeamsLink];

export function parseMeetingUrl(input: string) {
  const url = URL.parse(input.trim());
  if (url?.protocol === "https:" && !url.username && !url.password && !url.port) {
    for (const recognize of meetingLinkRecognizers) {
      const meeting = recognize(url);
      if (meeting) return meeting;
    }
  }
  throw new ClientError("BAD_REQUEST", "Enter a valid meeting link.");
}
