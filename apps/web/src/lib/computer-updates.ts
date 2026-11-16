import { createComputerUpdates } from "@rakazo/core";
import { rpc, SPACE_SELECTED_EVENT, selectedSpaceId } from "./rpc";
export const computerUpdates = createComputerUpdates({
  list: () => rpc.computer.updates(),
  start: (botId, action) => rpc.computer[action]({ botId }),
  dismiss: (id) => rpc.computer.dismissUpdate({ id }),
  onSpaceChange: (listener) => {
    // Opening a chat reselects its Space even when it is already the selected one.
    let current = selectedSpaceId();
    const selected = () => {
      const next = selectedSpaceId();
      if (next === current) return;
      current = next;
      listener();
    };
    window.addEventListener(SPACE_SELECTED_EVENT, selected);
    return () => window.removeEventListener(SPACE_SELECTED_EVENT, selected);
  },
});
