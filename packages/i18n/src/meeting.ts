import { i18n } from "@lingui/core";
import type { MeetingPlatform, MeetingStatus } from "@rakazo/contracts";
import { meetingPlatformNames } from "@rakazo/core";

export function meetingPlatformLabel(platform: MeetingPlatform): string {
  return meetingPlatformNames[platform];
}

export function meetingStatusLabel(status: MeetingStatus): string {
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

type CalendarEventState = {
  selection: "none" | "once" | "series" | "skipped" | "another_bot";
  recurring: boolean;
  scheduled: boolean;
  quotaReached?: boolean;
};

export type MeetingCalendarAction = "once" | "series" | "skip" | "removeSeries";

export function meetingCalendarStatusLabel({
  selection,
  scheduled,
  quotaReached,
}: CalendarEventState) {
  if (selection === "another_bot") return i18n._({ id: "Another bot", message: "Another bot" });
  if (selection === "skipped") return i18n._({ id: "Skipped", message: "Skipped" });
  if (scheduled) return meetingStatusLabel("scheduled");
  if (quotaReached) return i18n._({ id: "Space limit reached", message: "Space limit reached" });
  return selection === "none" ? undefined : i18n._({ id: "Selected", message: "Selected" });
}

export function meetingCalendarActions(event: CalendarEventState): MeetingCalendarAction[] {
  // Choosing the already selected scope is a no-op, including choosing this
  // occurrence when the whole series is already selected.
  if (event.selection === "series") return ["skip", "removeSeries"];
  if (event.selection === "once") return event.recurring ? ["series", "skip"] : ["skip"];
  return event.recurring ? ["once", "series"] : ["once"];
}

export function meetingCalendarSharingNotice(actions: readonly MeetingCalendarAction[]) {
  if (!actions.includes("once") && !actions.includes("series")) return;
  return i18n._({
    id: "Choosing a join option shares transcripts with this Space.",
    message: "Choosing a join option shares transcripts with this Space.",
  });
}

export function meetingCalendarActionLabel(action: MeetingCalendarAction) {
  switch (action) {
    case "once":
      return i18n._({ id: "Join this meeting", message: "Join this meeting" });
    case "series":
      return i18n._({ id: "Join this series", message: "Join this series" });
    case "skip":
      return i18n._({ id: "Skip this meeting", message: "Skip this meeting" });
    case "removeSeries":
      return i18n._({ id: "Stop joining this series", message: "Stop joining this series" });
  }
}
