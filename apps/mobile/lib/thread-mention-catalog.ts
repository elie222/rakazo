import type { Connection, ConnectionCatalogItem, Routine } from "@rakazo/contracts";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { captureApiRequestContext, currentApiBase, rpc, selectedSpaceId } from "./api";
import { currentSessionGeneration, subscribeSessionGeneration } from "./session";

type MentionBot = { id: string; name: string };
type MentionCatalog = {
  routines: Array<Routine & { botName: string }>;
  connectors: Array<{
    id: string;
    name: string;
    authStatus: "connected" | "needs_auth";
    connectionId?: string;
  }>;
};
type MentionCatalogState = MentionCatalog & { scope: string; activation: symbol | null };

const EMPTY_CATALOG: MentionCatalog = { routines: [], connectors: [] };
const ROUTINE_REQUEST_CONCURRENCY = 4;

export function useThreadMentionCatalog(owner: string, bots: readonly MentionBot[]) {
  const generation = useSyncExternalStore(subscribeSessionGeneration, currentSessionGeneration);
  const apiBase = currentApiBase();
  const spaceId = selectedSpaceId();
  const scope = JSON.stringify([owner, apiBase, generation, spaceId]);
  const [state, setState] = useState<MentionCatalogState>({
    scope,
    activation: null,
    ...EMPTY_CATALOG,
  });
  if (state.scope !== scope) setState({ scope, activation: null, ...EMPTY_CATALOG });
  const activation = state.scope === scope ? state.activation : null;
  const onMentionRequested = useCallback(() => {
    setState((current) =>
      current.scope === scope && !current.activation
        ? { ...current, activation: Symbol() }
        : current,
    );
  }, [scope]);

  useEffect(() => {
    if (!activation) return;
    if (bots.length === 0) {
      setState((current) =>
        current.scope === scope && current.activation === activation
          ? { ...current, ...EMPTY_CATALOG }
          : current,
      );
      return;
    }
    const abort = new AbortController();
    function invalidateActivation() {
      if (abort.signal.aborted) return;
      abort.abort();
      setState((current) =>
        current.scope === scope && current.activation === activation
          ? { scope, activation: null, ...EMPTY_CATALOG }
          : current,
      );
    }
    const isCurrent = () => {
      if (abort.signal.aborted) return false;
      if (
        apiBase !== currentApiBase() ||
        generation !== currentSessionGeneration() ||
        spaceId !== selectedSpaceId()
      ) {
        invalidateActivation();
        return false;
      }
      return true;
    };
    function update(catalog: Partial<MentionCatalog>) {
      if (!isCurrent()) return;
      setState((current) =>
        current.scope === scope && current.activation === activation
          ? { ...current, ...catalog }
          : current,
      );
    }
    let failed = false;
    const allowRetry = () => {
      if (!isCurrent()) return;
      setState((current) =>
        current.scope === scope && current.activation === activation
          ? { ...current, activation: null }
          : current,
      );
    };
    async function load() {
      if (!isCurrent()) return;
      const requestContext = await captureApiRequestContext();
      if (!isCurrent()) return;
      if (
        requestContext.apiBase !== apiBase ||
        requestContext.sessionGeneration !== generation ||
        (requestContext.headers["x-rakazo-space-id"] ?? null) !== spaceId
      ) {
        invalidateActivation();
        return;
      }
      const options = { signal: abort.signal, requestContext };
      const lists: MentionCatalog["routines"][] = new Array(bots.length);
      let nextBot = 0;
      async function loadRoutines() {
        while (isCurrent() && nextBot < bots.length) {
          const index = nextBot++;
          const bot = bots[index]!;
          try {
            const rows = await rpc<Routine[]>("routines/list", { botId: bot.id }, options);
            if (!isCurrent()) return;
            lists[index] = rows.map((routine) => ({ ...routine, botName: bot.name }));
          } catch {
            failed = true;
            lists[index] = [];
          }
        }
      }
      const routines = Promise.all(
        Array.from({ length: Math.min(ROUTINE_REQUEST_CONCURRENCY, bots.length) }, loadRoutines),
      ).then(() => update({ routines: lists.flat() }));
      const connectors = Promise.all([
        rpc<Connection[]>("connections/list", {}, options).catch(() => {
          failed = true;
          return [] as Connection[];
        }),
        rpc<ConnectionCatalogItem[]>("connections/catalog", {}, options).catch(() => {
          failed = true;
          return [] as ConnectionCatalogItem[];
        }),
      ]).then(([connections, catalog]) => {
        if (!isCurrent()) return;
        const connected = connections.filter((row) => row.status === "connected");
        const connectors: MentionCatalog["connectors"] = connected.map((row) => ({
          id: row.id,
          name: row.displayName,
          authStatus: "connected",
          connectionId: row.id,
        }));
        for (const item of catalog) {
          if (item.connected || item.noAuth) continue;
          if (
            connected.some(
              (row) =>
                row.provider.toLowerCase() === item.slug.toLowerCase() ||
                row.displayName.toLowerCase() === item.name.toLowerCase(),
            )
          )
            continue;
          connectors.push({
            id: `catalog:${item.connectorId}:${item.slug}`,
            name: item.name,
            authStatus: "needs_auth",
          });
        }
        update({ connectors });
      });
      await Promise.all([routines, connectors]);
      if (failed) allowRetry();
    }
    void load().catch(allowRetry);
    return () => abort.abort();
  }, [activation, apiBase, bots, generation, scope, spaceId]);

  const catalog = state.scope === scope ? state : EMPTY_CATALOG;
  return {
    routines: catalog.routines,
    connectors: catalog.connectors,
    onMentionRequested,
  };
}
