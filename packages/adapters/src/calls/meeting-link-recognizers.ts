import type { MeetingLinkRecognizer } from "@rakazo/core";
import { googleMeetLinks } from "../providers/meeting-link/google-meet/google-meet-link.js";
import { teamsLinks } from "../providers/meeting-link/microsoft-teams/teams-link.js";
import { zoomLinks } from "../providers/meeting-link/zoom/zoom-link.js";

/** Every video call service whose meeting links Rakazo can read, for `findMeetingLinks`. */
export const meetingLinkRecognizers: readonly MeetingLinkRecognizer[] = [
  googleMeetLinks,
  zoomLinks,
  teamsLinks,
];
