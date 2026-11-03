import type { SearchHit, SpaceBot, SpaceGroup } from "@rakazo/contracts";
import { dedupeSearchHits, searchHitListKey } from "@rakazo/core";
import type { MobileBot, MobileGroup } from "./api";
import { t } from "./i18n";
import { filterBots } from "./inbox";
import type { InboxSpace } from "./inbox-spaces";
import { previewSnippet } from "./preview";
import { mobileSearchDestination } from "./search-destination";
import { searchHitRowPreview } from "./search-list";

export type SearchSheetRow = {
  key: string;
  title: string;
  preview: string;
  label: string;
  bot?: SpaceBot | MobileBot;
  group?: SpaceGroup | MobileGroup;
  kind: SearchHit["kind"];
  spaceId?: string;
  destination: ReturnType<typeof mobileSearchDestination>;
};

export function searchKindLabel(hit: SearchHit): string {
  switch (hit.kind) {
    case "conversation":
      return hit.groupId ? t("Group") : t("Bot");
    case "message":
      return t("Message");
    case "file":
      return t("File");
    case "link":
      return t("Link");
    case "routine":
      return t("Routine");
  }
}

export function searchSheetRows(
  spaces: readonly InboxSpace[],
  query: string,
  hits: readonly SearchHit[],
): SearchSheetRow[] {
  // An archived bot is in the roster only while its read-only chat opens; search skips it.
  const bots = spaces
    .flatMap((space) => space.bots)
    .filter((bot) => !("archivedAt" in bot && bot.archivedAt));
  const groups = spaces.flatMap((space) => space.groups);
  const needle = query.trim().toLowerCase();
  const rows: SearchSheetRow[] = [
    ...filterBots(bots, query).map(
      (bot): SearchSheetRow => ({
        key: `bot-${bot.id}`,
        title: bot.name,
        preview: previewSnippet(bot.preview, 40) || t("No messages yet"),
        label: t("Bot"),
        bot,
        kind: "conversation",
        spaceId: bot.spaceId,
        destination: { pathname: "/thread", params: { botId: bot.id, name: bot.name } },
      }),
    ),
    ...groups
      .filter((group) => `${group.name} ${group.preview}`.toLowerCase().includes(needle))
      .map(
        (group): SearchSheetRow => ({
          key: `group-${group.id}`,
          title: group.name,
          preview:
            previewSnippet(group.preview, 40) ||
            group.members.map((member) => member.name).join(", "),
          label: t("Group"),
          group,
          kind: "conversation",
          spaceId: group.spaceId,
          destination: {
            pathname: "/group-thread",
            params: { groupId: group.id, name: group.name },
          },
        }),
      ),
  ];
  if (!needle) return rows;
  const chats = new Set(rows.map((row) => row.key));
  for (const hit of dedupeSearchHits(hits)) {
    if (
      hit.kind === "conversation" &&
      chats.has(hit.groupId ? `group-${hit.groupId}` : `bot-${hit.botId}`)
    )
      continue;
    const bot = hit.botId ? bots.find((bot) => bot.id === hit.botId) : undefined;
    const group = hit.groupId ? groups.find((group) => group.id === hit.groupId) : undefined;
    rows.push({
      key: searchHitListKey(hit),
      title: hit.title,
      preview: searchHitRowPreview(hit),
      label: searchKindLabel(hit),
      bot,
      group,
      kind: hit.kind,
      spaceId: group?.spaceId ?? bot?.spaceId,
      destination: mobileSearchDestination(hit),
    });
  }
  return rows;
}
