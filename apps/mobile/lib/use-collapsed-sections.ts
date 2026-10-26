import { useCallback, useEffect, useMemo, useState } from "react";
import type { CollapsedSections } from "./collapsed-sections";
import { loadCollapsedSections, saveCollapsedSections } from "./collapsed-sections";

/**
 * Roster parent bot ids and section heading keys, kept on this device for the last account
 * that changed them. `loaded` turns true once they are read, so the inbox can wait for them and
 * sections don't fold on launch.
 */
export function useCollapsedSections(userId: string | undefined) {
  const [collapsedSections, setCollapsedSections] = useState<CollapsedSections | null>(null);
  useEffect(() => {
    void loadCollapsedSections().then((stored) =>
      setCollapsedSections(stored ?? { keys: new Set() }),
    );
  }, []);
  const collapsed = useMemo(
    () =>
      collapsedSections && collapsedSections.userId === userId
        ? collapsedSections.keys
        : new Set<string>(),
    [collapsedSections, userId],
  );
  const toggleCollapsed = useCallback(
    (key: string) => {
      setCollapsedSections((previous) => {
        const next = new Set(previous && previous.userId === userId ? previous.keys : []);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        return { userId, keys: next };
      });
    },
    [userId],
  );
  useEffect(() => {
    if (collapsedSections?.userId) {
      saveCollapsedSections(collapsedSections.userId, collapsedSections.keys);
    }
  }, [collapsedSections]);
  return { collapsed, toggleCollapsed, loaded: collapsedSections !== null };
}
