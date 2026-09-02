import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type HostDiskSettings = {
  enabled: boolean;
  /** Absolute folder paths the user explicitly granted. Empty means no access. */
  roots: string[];
  /** ISO time of the last desktop/mobile heartbeat while opted in. */
  clientSeenAt: string | null;
};

const DEFAULT_SETTINGS: HostDiskSettings = {
  enabled: false,
  roots: [],
  clientSeenAt: null,
};

/** How long a client heartbeat keeps host tools available. */
export const HOST_DISK_CLIENT_TTL_MS = 90_000;

export function hostDiskSettingsPath(dataDir: string, userId: string) {
  return path.join(dataDir, "host-disk", "settings", `${userId}.json`);
}

export async function loadHostDiskSettings(
  dataDir: string,
  userId: string,
): Promise<HostDiskSettings> {
  try {
    const raw = JSON.parse(
      await readFile(hostDiskSettingsPath(dataDir, userId), "utf8"),
    ) as unknown;
    return normalizeHostDiskSettings(raw);
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export async function saveHostDiskSettings(
  dataDir: string,
  userId: string,
  settings: HostDiskSettings,
): Promise<HostDiskSettings> {
  const normalized = normalizeHostDiskSettings(settings);
  const file = hostDiskSettingsPath(dataDir, userId);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(normalized, null, 2)}\n`, "utf8");
  return normalized;
}

/** Per dataDir+userId chain so overlapping heartbeat/setEnabled/setRoots RMW cannot clobber. */
const hostDiskSettingsUpdateChains = new Map<string, Promise<unknown>>();

function hostDiskSettingsUpdateKey(dataDir: string, userId: string) {
  return `${dataDir}\0${userId}`;
}

/**
 * Load → mutate → save under a per-user serial queue. Concurrent handlers that
 * each load/save would otherwise lose updates (e.g. heartbeat vs setRoots).
 */
export async function updateHostDiskSettings(
  dataDir: string,
  userId: string,
  update: (current: HostDiskSettings) => HostDiskSettings | Promise<HostDiskSettings>,
): Promise<HostDiskSettings> {
  const key = hostDiskSettingsUpdateKey(dataDir, userId);
  const previous = hostDiskSettingsUpdateChains.get(key) ?? Promise.resolve();
  const run = previous.then(
    async () => {
      const current = await loadHostDiskSettings(dataDir, userId);
      return saveHostDiskSettings(dataDir, userId, await update(current));
    },
    async () => {
      const current = await loadHostDiskSettings(dataDir, userId);
      return saveHostDiskSettings(dataDir, userId, await update(current));
    },
  );
  hostDiskSettingsUpdateChains.set(
    key,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

export function normalizeHostDiskSettings(value: unknown): HostDiskSettings {
  if (!value || typeof value !== "object") return { ...DEFAULT_SETTINGS };
  const record = value as Record<string, unknown>;
  const roots = Array.isArray(record.roots)
    ? [
        ...new Set(
          record.roots.filter(
            (item): item is string => typeof item === "string" && item.length > 0,
          ),
        ),
      ]
    : [];
  return {
    enabled: record.enabled === true,
    roots,
    clientSeenAt: typeof record.clientSeenAt === "string" ? record.clientSeenAt : null,
  };
}

export function hostDiskClientIsFresh(
  settings: HostDiskSettings,
  now = Date.now(),
  ttlMs = HOST_DISK_CLIENT_TTL_MS,
) {
  if (!settings.clientSeenAt) return false;
  const seen = Date.parse(settings.clientSeenAt);
  if (!Number.isFinite(seen)) return false;
  return now - seen <= ttlMs;
}

/** Tools require explicit opt-in, at least one granted root, and a fresh client. */
export function hostDiskAccessAllowed(settings: HostDiskSettings, now = Date.now()) {
  return settings.enabled && settings.roots.length > 0 && hostDiskClientIsFresh(settings, now);
}
