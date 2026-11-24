import { Directory, File, Paths } from "expo-file-system";

type Entry = { file: File; size: number; order: number };

/** A limit on how many files like the one written the folder may hold. */
export type CacheCount = { matches: (name: string) => boolean; max: number };

/**
 * One folder of the app cache that keeps itself within a budget, oldest files first. Its files
 * and sizes are read from disk once per launch and kept up to date by its own writes and removals,
 * so a write never rescans the folder.
 */
export function cacheFolder(name: string) {
  const root = new Directory(Paths.cache, name);
  let index: Map<string, Entry> | null = null;
  let lastOrder = 0;

  function entries(): Map<string, Entry> {
    // Gone from disk (cleared, or removed by the OS): nothing is left to count.
    if (!root.exists) index = new Map();
    if (index) return index;
    const found = new Map<string, Entry>();
    const walk = (directory: Directory) => {
      for (const entry of directory.list()) {
        if (entry instanceof File)
          found.set(entry.uri, { file: entry, size: entry.size, order: entry.lastModified ?? 0 });
        else walk(entry);
      }
    };
    walk(root);
    for (const entry of found.values()) lastOrder = Math.max(lastOrder, entry.order);
    index = found;
    return found;
  }

  function remove(file: File): void {
    if (file.exists) file.delete();
    index?.delete(file.uri);
  }

  return {
    root,
    remove,
    /** Deletes the whole folder. */
    clear(): void {
      if (root.exists) root.delete();
      index = new Map();
    },
    /**
     * Writes `text` to `file` once the folder has room: the oldest files like it go first while
     * a `counts` limit that matches it is reached, then the oldest `evictable` files while the
     * folder would pass `totalBytes`. Throws, writing nothing, when no file may make room.
     */
    write(
      file: File,
      text: string,
      limits: { totalBytes: number; evictable?: (name: string) => boolean; counts?: CacheCount[] },
    ): void {
      const { totalBytes, evictable = () => true, counts = [] } = limits;
      const bytes = new TextEncoder().encode(text).length;
      const others = [...entries().values()]
        .filter((entry) => entry.file.uri !== file.uri)
        .sort((a, b) => a.order - b.order);
      const evictOldest = (allowed: (name: string) => boolean) => {
        const oldest = others.find((entry) => allowed(entry.file.name));
        if (!oldest) throw new Error("Cache budget unavailable");
        others.splice(others.indexOf(oldest), 1);
        remove(oldest.file);
      };
      // Only when a limit is reached: files the OS removed meanwhile no longer count.
      let pruned = false;
      const prune = () => {
        if (pruned) return;
        pruned = true;
        for (const entry of [...others]) {
          if (entry.file.exists) continue;
          others.splice(others.indexOf(entry), 1);
          index?.delete(entry.file.uri);
        }
      };
      for (const count of counts) {
        if (!count.matches(file.name)) continue;
        while (others.filter((entry) => count.matches(entry.file.name)).length >= count.max) {
          if (!pruned) {
            prune();
            continue;
          }
          evictOldest(count.matches);
        }
      }
      const total = () => others.reduce((sum, entry) => sum + entry.size, bytes);
      while (total() > totalBytes) {
        if (!pruned) prune();
        else evictOldest(evictable);
      }
      file.create({ overwrite: true });
      file.writeSync(text);
      lastOrder = Math.max(lastOrder + 1, Date.now());
      entries().set(file.uri, { file, size: bytes, order: lastOrder });
    },
  };
}
