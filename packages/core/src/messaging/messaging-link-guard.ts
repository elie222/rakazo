// Only issuance is shared across mounts; displayed results stay owned by each screen.
type IssuanceState = { pending: object | null; listeners: Set<() => void> };
const states = new WeakMap<object, Map<string | number, IssuanceState>>();

/**
 * Link issuance is a narrow exception to useSave: its slot must survive screen remounts,
 * while picker changes invalidate picker-bound results but preserve workspace-bound codes.
 * The save hooks own one mounted screen and cannot coordinate that credential lifetime.
 * Screens keep RPC, rendering and navigation lifecycle; this guard does not retry or cancel writes.
 */
export function createMessagingLinkGuard(scope: object = {}, session: string | number = "") {
  let sessions = states.get(scope);
  if (!sessions) {
    sessions = new Map();
    states.set(scope, sessions);
  }
  let state = sessions.get(session);
  if (!state) {
    state = { pending: null, listeners: new Set() };
    sessions.set(session, state);
  }
  const issuance = state;
  const notify = () => {
    for (const listener of issuance.listeners) listener();
  };
  let current: object | null = null;
  let fromPicker = true;
  return {
    isPending: () => issuance.pending !== null,
    subscribe(listener: () => void) {
      issuance.listeners.add(listener);
      return () => {
        issuance.listeners.delete(listener);
      };
    },
    begin(pickerBound = true) {
      if (issuance.pending) return null;
      const request = {};
      current = request;
      issuance.pending = request;
      notify();
      fromPicker = pickerBound;
      return {
        isCurrent: () => current === request,
        finish() {
          if (issuance.pending === request) {
            issuance.pending = null;
            notify();
          }
        },
      };
    },
    /** Picker changes must not discard workspace-bound pending or displayed codes. */
    invalidate(pickerOnly = false) {
      if (pickerOnly && !fromPicker) return false;
      current = null;
      // An invalidated RPC still occupies the issuance slot until it settles.
      return true;
    },
  };
}
