import type { ComputerModelSelection, ComputerModelView } from "@rakazo/contracts";

type State = {
  view: ComputerModelView | null;
  busy: boolean;
  stale: boolean;
  error: string | null;
};
const pending = new Map<string, Promise<unknown>>();
// Metadata only; a revisit shows the last readback disabled until fresh authentication succeeds.
const cached = new Map<string, ComputerModelView>();
function remember(key: string, view: ComputerModelView) {
  cached.delete(key);
  cached.set(key, view);
  if (cached.size > 100) cached.delete(cached.keys().next().value!);
}
/** Shared web/Electron/mobile save/readback state; failures never become a default selection. */
export function createComputerModelSettings(
  api: {
    load(): Promise<ComputerModelView>;
    save(selection: ComputerModelSelection): Promise<ComputerModelView>;
  },
  identity: string,
) {
  let state: State = { view: cached.get(identity) ?? null, busy: true, stale: true, error: null };
  let generation = 0;
  const listeners = new Set<() => void>();
  const publish = (patch: Partial<State>) => {
    if (patch.view) remember(identity, patch.view);
    state = { ...state, ...patch };
    for (const fn of listeners) fn();
  };
  return {
    snapshot: () => state,
    subscribe: (fn: () => void) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    async load() {
      const version = ++generation;
      publish({ busy: true, error: null });
      try {
        await pending.get(identity)?.catch(() => undefined);
        const view = await api.load();
        if (version === generation) publish({ view, busy: false, stale: false, error: null });
      } catch (e) {
        if (version === generation)
          publish({ busy: false, stale: true, error: e instanceof Error ? e.message : String(e) });
      }
    },
    async save(selection: ComputerModelSelection) {
      if (state.busy || state.stale) return;
      const version = ++generation;
      publish({ busy: true, error: null });
      const work = (pending.get(identity) ?? Promise.resolve())
        .catch(() => undefined)
        .then(() => api.save(selection));
      pending.set(identity, work);
      try {
        const view = await work;
        if (version === generation) publish({ view, busy: false, stale: false });
      } catch (e) {
        if (version === generation)
          publish({ busy: false, stale: true, error: e instanceof Error ? e.message : String(e) });
      } finally {
        if (pending.get(identity) === work) pending.delete(identity);
      }
    },
  };
}
export function computerModelKey(selection: ComputerModelSelection): string {
  return selection?.mode === "model"
    ? JSON.stringify([selection.provider, selection.credentialId, selection.modelId])
    : (selection?.mode ?? "inherit");
}
