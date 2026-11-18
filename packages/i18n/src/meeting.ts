import { i18n } from "@lingui/core";
import { meetingPlatformNames } from "@rakazo/core";

export function meetingPlatformLabel(platform: "zoom" | "google_meet"): string {
  return meetingPlatformNames[platform];
}

export function meetingStatusLabel(
  status:
    | "scheduled"
    | "joining"
    | "waiting"
    | "joined"
    | "leaving"
    | "processing"
    | "ready"
    | "failed"
    | "ended",
): string {
  switch (status) {
    case "scheduled":
      return i18n._({ id: "Scheduled", message: "Scheduled" });
    case "joining":
      return i18n._({ id: "Joining…", message: "Joining…" });
    case "waiting":
      return i18n._({ id: "Waiting for admission", message: "Waiting for admission" });
    case "joined":
      return i18n._({ id: "In the meeting", message: "In the meeting" });
    case "leaving":
      return i18n._({ id: "Leaving…", message: "Leaving…" });
    case "processing":
      return i18n._({ id: "Preparing transcript…", message: "Preparing transcript…" });
    case "ready":
      return i18n._({ id: "Transcript ready", message: "Transcript ready" });
    case "failed":
      return i18n._({ id: "Meeting failed", message: "Meeting failed" });
    case "ended":
      return i18n._({ id: "Meeting ended", message: "Meeting ended" });
  }
}

export function meetingTime(utcMs: number): string {
  return new Date(utcMs).toLocaleString(i18n.locale || "en", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export function transcriptTime(offsetMs: number): string {
  const seconds = Math.floor(Math.max(0, offsetMs) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
