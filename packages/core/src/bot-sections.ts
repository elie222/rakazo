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
  options: { includeEmptySections?: boolean } = {},
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
    if (members.length > 0 || options.includeEmptySections) {
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

export function reorderBotTo<T extends { id: string }>(
  bots: readonly T[],
  sourceId: string,
  targetId: string,
): readonly T[] {
  const sourceIndex = bots.findIndex((bot) => bot.id === sourceId);
  const targetIndex = bots.findIndex((bot) => bot.id === targetId);
  if (sourceIndex < 0 || targetIndex < 0 || sourceIndex === targetIndex) return bots;
  const reordered = [...bots];
  const [source] = reordered.splice(sourceIndex, 1);
  if (!source) return bots;
  reordered.splice(targetIndex, 0, source);
  return reordered;
}

export type RosterParentable = {
  id: string;
  parentBotId?: string | null;
};

export type NestedRosterRow<T> = {
  item: T;
  depth: number;
  hasChildren: boolean;
  /** Parent this row renders under, or null for a root; siblings share it. */
  parentId: string | null;
};

/**
 * Nest roster items by parentBotId within one section/list, then flatten for
 * rendering. Parents missing from the list (other section, filtered out) stay
 * roots. Collapsed parents hide all descendants.
 */
export function nestRosterByParent<T extends RosterParentable>(
  items: readonly T[],
  collapsedIds: ReadonlySet<string> = new Set(),
): NestedRosterRow<T>[] {
  const byId = new Map(items.map((item) => [item.id, item]));
  const children = new Map<string, T[]>();
  const roots: T[] = [];

  for (const item of items) {
    const parentId = item.parentBotId ?? null;
    if (parentId && byId.has(parentId) && parentId !== item.id) {
      const siblings = children.get(parentId) ?? [];
      siblings.push(item);
      children.set(parentId, siblings);
    } else {
      roots.push(item);
    }
  }

  const rows: NestedRosterRow<T>[] = [];
  const visited = new Set<string>();
  const markHidden = (item: T) => {
    if (visited.has(item.id)) return;
    visited.add(item.id);
    for (const child of children.get(item.id) ?? []) markHidden(child);
  };
  const visit = (
    item: T,
    depth: number,
    parentId: string | null,
    ancestors: ReadonlySet<string>,
  ) => {
    if (ancestors.has(item.id) || visited.has(item.id)) return;
    visited.add(item.id);
    const kids = children.get(item.id) ?? [];
    rows.push({ item, depth, hasChildren: kids.length > 0, parentId });
    if (kids.length === 0) return;
    if (collapsedIds.has(item.id)) {
      for (const child of kids) markHidden(child);
      return;
    }
    const nextAncestors = new Set(ancestors);
    nextAncestors.add(item.id);
    for (const child of kids) visit(child, depth + 1, item.id, nextAncestors);
  };

  for (const root of roots) visit(root, 0, null, new Set());
  // Cycles leave no natural root; surface remaining items in source order.
  for (const item of items) {
    if (!visited.has(item.id)) visit(item, 0, null, new Set());
  }
  return rows;
}
