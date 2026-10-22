import { useCallback, useEffect, useState } from "react";

function collapsedSidebarSectionsStorageKey(userId: string | null | undefined): string | null {
  if (!userId) return null;
  return `rakazo:collapsed-sidebar-sections:${userId}`;
}

function collapsedRosterParentsStorageKey(userId: string | null | undefined): string | null {
  if (!userId) return null;
  return `rakazo:collapsed-roster-parents:${userId}`;
}

function readCollapsedIdSet(storageKey: string | null): Set<string> {
  if (!storageKey) return new Set();
  try {
    const value = window.localStorage.getItem(storageKey);
    const keys: unknown = value ? JSON.parse(value) : [];
    return new Set(
      Array.isArray(keys) ? keys.filter((key): key is string => typeof key === "string") : [],
    );
  } catch {
    return new Set();
  }
}

function toggleCollapsedIdSet(
  previous: ReadonlySet<string>,
  id: string,
  storageKey: string | null,
): Set<string> {
  const next = new Set(previous);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  if (storageKey) {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify([...next]));
    } catch {
      // Keep the UI usable when storage is unavailable.
    }
  }
  return next;
}

function readCollapsedSidebarSections(userId: string | null | undefined): Set<string> {
  return readCollapsedIdSet(collapsedSidebarSectionsStorageKey(userId));
}

function readCollapsedRosterParents(userId: string | null | undefined): Set<string> {
  return readCollapsedIdSet(collapsedRosterParentsStorageKey(userId));
}

export function useSidebarExpansion(userId: string | null | undefined) {
  const [collapsedSidebarSections, setCollapsedSidebarSections] = useState(() => new Set<string>());
  const [collapsedRosterParents, setCollapsedRosterParents] = useState(() => new Set<string>());

  useEffect(() => {
    setCollapsedSidebarSections(readCollapsedSidebarSections(userId));
    setCollapsedRosterParents(readCollapsedRosterParents(userId));
  }, [userId]);
  const toggleSidebarSection = useCallback(
    (key: string) => {
      setCollapsedSidebarSections((previous) =>
        toggleCollapsedIdSet(previous, key, collapsedSidebarSectionsStorageKey(userId)),
      );
    },
    [userId],
  );
  const toggleRosterParent = useCallback(
    (botId: string) => {
      setCollapsedRosterParents((previous) =>
        toggleCollapsedIdSet(previous, botId, collapsedRosterParentsStorageKey(userId)),
      );
    },
    [userId],
  );
  return {
    collapsedSidebarSections,
    collapsedRosterParents,
    toggleSidebarSection,
    toggleRosterParent,
  };
}
