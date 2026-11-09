import type { AttentionItem } from "@rakazo/contracts";
import { attentionSectionKey } from "@rakazo/core";
import type { Href } from "expo-router";
import { rpc } from "./api";

export type AttentionSectionKey = "waiting" | "failed" | "routines";

export type AttentionSection = {
  key: AttentionSectionKey;
  title: string;
  items: AttentionItem[];
};

export async function fetchAttentionItems(): Promise<AttentionItem[]> {
  return (await rpc("attention/list")).items;
}

/** The same order the server uses: items waiting on a person, then failures, then behind schedules. */
export function attentionSections(
  items: readonly AttentionItem[],
  translate: (message: string) => string,
): AttentionSection[] {
  return [
    {
      key: "waiting",
      title: translate("Waiting on you"),
      items: items.filter((item) => attentionSectionKey(item.kind) === "waiting"),
    },
    {
      key: "failed",
      title: translate("Failed"),
      items: items.filter((item) => attentionSectionKey(item.kind) === "failed"),
    },
    {
      key: "routines",
      title: translate("Routines behind"),
      items: items.filter((item) => attentionSectionKey(item.kind) === "routines"),
    },
  ].filter((section) => section.items.length > 0) as AttentionSection[];
}

export function attentionTitle(
  item: AttentionItem,
  translate: (message: string, values?: Record<string, string | number>) => string,
): string {
  const name = item.groupName ?? item.botName;
  switch (item.kind) {
    case "question":
      return translate("{name} needs an answer", { name });
    case "approval":
      return translate("{name} needs approval", { name });
    case "secret":
      return translate("{name} needs a sign-in", { name });
    case "takeover":
      return translate("{name} needs the screen", { name });
    case "failed":
      return translate("{name} failed", { name });
    case "routine_delayed":
      return translate("{name} is behind schedule", { name });
  }
}

export function attentionDetail(
  item: AttentionItem,
  translate: (message: string) => string,
): string {
  if (item.detail) return item.detail;
  switch (item.kind) {
    case "takeover":
      return translate("Open its computer to continue.");
    case "failed":
      return translate("The run stopped before it finished.");
    case "routine_delayed":
      return translate("Its next scheduled run is overdue.");
    default:
      return "";
  }
}

export function attentionHref(item: AttentionItem): Href {
  if (item.groupId) {
    return {
      pathname: "/group-thread",
      params: { groupId: item.groupId, name: item.groupName ?? "" },
    };
  }
  return { pathname: "/thread", params: { botId: item.botId, name: item.botName } };
}

export function attentionIcon(item: AttentionItem): {
  ios: string;
  android:
    | "chatbubble-outline"
    | "shield-checkmark-outline"
    | "key-outline"
    | "desktop-outline"
    | "warning-outline"
    | "time-outline";
} {
  switch (item.kind) {
    case "question":
      return { ios: "bubble.left", android: "chatbubble-outline" };
    case "approval":
      return { ios: "checkmark.shield", android: "shield-checkmark-outline" };
    case "secret":
      return { ios: "key", android: "key-outline" };
    case "takeover":
      return { ios: "display", android: "desktop-outline" };
    case "failed":
      return { ios: "exclamationmark.triangle", android: "warning-outline" };
    case "routine_delayed":
      return { ios: "clock.badge.exclamationmark", android: "time-outline" };
  }
}
