// Only issuance is shared across mounts; displayed results stay owned by each screen.
const pendingByScope = new WeakMap<object, object>();

/** Shared issuance rules; screens own their RPC, rendering, and navigation lifecycle. */
export function createMessagingLinkGuard(scope: object = {}) {
  let current: object | null = null;
  let fromPicker = true;
  return {
    begin(pickerBound = true) {
      if (pendingByScope.has(scope)) return null;
      const request = {};
      current = request;
      pendingByScope.set(scope, request);
      fromPicker = pickerBound;
      return {
        isCurrent: () => current === request,
        finish() {
          if (pendingByScope.get(scope) === request) pendingByScope.delete(scope);
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
