export type BotListSection<T> = {
  key: string;
  title: string | null;
  bots: T[];
};

type Section = { id: string; name: string };
type SectionedBot = { pinned: boolean; sectionId: string | null };

export function groupBotsForSidebar<T extends SectionedBot>(
  bots: readonly T[],
  sections: readonly Section[],
): BotListSection<T>[] {
  const knownSectionIds = new Set(sections.map((section) => section.id));
  const pinned: T[] = [];
  const sectionMembers = new Map<string, T[]>();
  const unassigned: T[] = [];
  const grouped: BotListSection<T>[] = [];

  for (const bot of bots) {
    if (bot.pinned) {
      pinned.push(bot);
    } else if (bot.sectionId && knownSectionIds.has(bot.sectionId)) {
      const members = sectionMembers.get(bot.sectionId) ?? [];
      members.push(bot);
      sectionMembers.set(bot.sectionId, members);
    } else {
      unassigned.push(bot);
    }
  }

  if (pinned.length > 0) {
    grouped.push({ key: "pinned", title: "Pinned", bots: pinned });
  }
  for (const section of sections) {
    const members = sectionMembers.get(section.id) ?? [];
    if (members.length > 0) {
      grouped.push({ key: `section:${section.id}`, title: section.name, bots: members });
    }
  }
  if (unassigned.length > 0) {
    grouped.push({
      key: "unassigned",
      title: pinned.length > 0 || sections.length > 0 ? "Unassigned" : null,
      bots: unassigned,
    });
  }

  return grouped;
}
