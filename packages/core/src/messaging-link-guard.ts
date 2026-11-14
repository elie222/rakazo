/** Shared issuance rules; screens own their RPC, rendering, and navigation lifecycle. */
export function createMessagingLinkGuard() {
  let pending: object | null = null;
  let current: object | null = null;
  let fromPicker = true;
  return {
    begin(pickerBound = true) {
      if (pending) return null;
      const request = {};
      pending = current = request;
      fromPicker = pickerBound;
      return {
        isCurrent: () => current === request,
        finish() {
          if (pending === request) pending = null;
        },
      };
    },
    /** Picker changes must not discard workspace-bound pending or displayed codes. */
    invalidate(pickerOnly = false) {
      if (pickerOnly && !fromPicker) return false;
      current = null;
      // An invalidated RPC still occupies the issuance slot until its finally runs.
      return true;
    },
  };
}
