import type { MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import type { AttentionItem } from "@rakazo/contracts";
import { attentionSectionKey } from "@rakazo/core";
import type { Href } from "expo-router";
import { rpc } from "./api";

type Translate = (
  descriptor: MessageDescriptor,
  values?: Record<string, string | number>,
) => string;

const changedListeners = new Set<() => void>();

/** Lets the inbox's answer refresh the separate count kept by the Home row. */
export function subscribeAttentionChanged(listener: () => void): () => void {
  changedListeners.add(listener);
  return () => {
    changedListeners.delete(listener);
  };
}

export function notifyAttentionChanged(): void {
  for (const listener of [...changedListeners]) listener();
}

const SECTION_TITLES = {
  waiting: msg`Waiting on you`,
  failed: msg`Failed`,
  routines: msg`Routines behind`,
} as const;

const KIND_TITLES = {
  question: msg`{name} needs an answer`,
  approval: msg`{name} needs approval`,
  secret: msg`{name} needs a sign-in`,
  takeover: msg`{name} needs the screen`,
  failed: msg`{name} failed`,
  routine_delayed: msg`{name} is behind schedule`,
} as const;

const EMPTY_DETAILS = {
  takeover: msg`Open its computer to continue.`,
  failed: msg`The run stopped before it finished.`,
  routine_delayed: msg`Its next scheduled run is overdue.`,
} as const;

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
  translate: Translate,
): AttentionSection[] {
  return [
    {
      key: "waiting",
      title: translate(SECTION_TITLES.waiting),
      items: items.filter((item) => attentionSectionKey(item.kind) === "waiting"),
    },
    {
      key: "failed",
      title: translate(SECTION_TITLES.failed),
      items: items.filter((item) => attentionSectionKey(item.kind) === "failed"),
    },
    {
      key: "routines",
      title: translate(SECTION_TITLES.routines),
      items: items.filter((item) => attentionSectionKey(item.kind) === "routines"),
    },
  ].filter((section) => section.items.length > 0) as AttentionSection[];
}

export function attentionTitle(item: AttentionItem, translate: Translate): string {
  return translate(KIND_TITLES[item.kind], { name: item.groupName ?? item.botName });
}

export function attentionDetail(item: AttentionItem, translate: Translate): string {
  if (item.detail) return item.detail;
  if (item.kind === "takeover" || item.kind === "failed" || item.kind === "routine_delayed") {
    return translate(EMPTY_DETAILS[item.kind]);
  }
  return "";
}

export function attentionHref(item: AttentionItem): Href {
  const message = item.messageId ? { messageId: item.messageId } : {};
  if (item.groupId) {
    return {
      pathname: "/group-thread",
      params: { groupId: item.groupId, name: item.groupName ?? "", ...message },
    };
  }
  return { pathname: "/thread", params: { botId: item.botId, name: item.botName, ...message } };
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
