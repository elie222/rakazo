import type { Connection, ConnectionCatalogItem, Me } from "@rakazo/contracts";
import { ConnectionCatalogItemSchema, ConnectionSchema } from "@rakazo/contracts";
import { Directory, File, Paths } from "expo-file-system";
import { currentApiBase, rpc, selectedSpaceId } from "./api";
import { t } from "./i18n";
import {
  currentSessionGeneration,
  loadVerifiedIntegrationsScope,
  saveVerifiedIntegrationsScope,
} from "./session";

export type IntegrationsSnapshot = {
  catalog: ConnectionCatalogItem[];
  connections: Connection[];
};
export type IntegrationsCacheScope = {
  apiBase: string;
  userId: string;
  spaceId: string;
  sessionGeneration: number;
  selectionId: string | null;
};

// Reuse verified identity within this session, never across sign-out or server changes.
let identity:
  | {
      apiBase: string;
      generation: number;
      selectionId: string | null;
      user: Promise<Pick<Me, "userId" | "spaceId">>;
    }
  | undefined;

export async function persistedIntegrationsCacheScope(): Promise<IntegrationsCacheScope | null> {
  const generation = currentSessionGeneration();
  const saved = await loadVerifiedIntegrationsScope();
  if (!saved) return null;
  const scope = { ...saved, sessionGeneration: generation };
  return isIntegrationsScopeCurrent(scope) ? scope : null;
}

export async function integrationsCacheScope(): Promise<IntegrationsCacheScope> {
  const apiBase = currentApiBase();
  const generation = currentSessionGeneration();
  const spaceId = selectedSpaceId();
  if (
    !identity ||
    identity.apiBase !== apiBase ||
    identity.generation !== generation ||
    identity.selectionId !== spaceId
  ) {
    const user = rpc<Pick<Me, "userId" | "spaceId">>("me");
    const entry = { apiBase, generation, selectionId: spaceId, user };
    identity = entry;
    void user.catch(() => {
      if (identity === entry) identity = undefined;
    });
  }
  const me = await identity.user;
  if (
    apiBase !== currentApiBase() ||
    generation !== currentSessionGeneration() ||
    spaceId !== selectedSpaceId()
  )
    throw new Error(t("Could not load integrations"));
  if (!me.userId || !(spaceId || me.spaceId)) throw new Error(t("Could not load integrations"));
  const scope = {
    apiBase,
    userId: me.userId,
    spaceId: spaceId || me.spaceId,
    sessionGeneration: generation,
    selectionId: spaceId,
  };
  void saveVerifiedIntegrationsScope(generation, scope);
  return scope;
}

export function isIntegrationsScopeCurrent(scope: IntegrationsCacheScope): boolean {
  return (
    scope.apiBase === currentApiBase() &&
    scope.sessionGeneration === currentSessionGeneration() &&
    scope.selectionId === selectedSpaceId()
  );
}

function scopeKey(scope: IntegrationsCacheScope): string {
  return JSON.stringify([scope.apiBase, scope.userId, scope.spaceId]);
}

function cacheFile(scope: IntegrationsCacheScope): File {
  const root = new Directory(
    Paths.cache,
    "integrations-v1",
    encodeURIComponent(scope.apiBase),
    `user-${encodeURIComponent(scope.userId)}`,
  );
  if (!root.exists) root.create({ intermediates: true, idempotent: true });
  return new File(root, `${encodeURIComponent(scope.spaceId)}.json`);
}

export function readIntegrationsCache(scope: IntegrationsCacheScope): IntegrationsSnapshot | null {
  try {
    const file = cacheFile(scope);
    if (!file.exists) return null;
    const data = JSON.parse(file.textSync());
    if (
      data.key !== scopeKey(scope) ||
      !Array.isArray(data.catalog) ||
      !Array.isArray(data.connections)
    )
      return null;
    return {
      catalog: data.catalog.map((item: unknown) => ConnectionCatalogItemSchema.parse(item)),
      connections: data.connections.map((item: unknown) => ConnectionSchema.parse(item)),
    };
  } catch {
    // OS eviction, corrupt files, and unavailable storage are all cold misses.
    return null;
  }
}

export function writeIntegrationsCache(
  scope: IntegrationsCacheScope,
  snapshot: IntegrationsSnapshot,
): void {
  try {
    const file = cacheFile(scope);
    file.create({ overwrite: true });
    file.write(JSON.stringify({ key: scopeKey(scope), ...snapshot }));
  } catch {
    // Disk cache is optional; storage failures must not block connection actions.
  }
}
