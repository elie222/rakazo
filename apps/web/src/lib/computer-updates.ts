import { createComputerUpdates } from "@rakazo/core";
import { rpc, SPACE_SELECTED_EVENT } from "./rpc";
export const computerUpdates = createComputerUpdates({
  list: () => rpc.computer.updates(),
  start: (botId, action) => rpc.computer[action]({ botId }),
  dismiss: (id) => rpc.computer.dismissUpdate({ id }),
  follow: async (onSignal, signal) => {
    const stream = await rpc.computer.subscribeUpdates(undefined, { signal });
    for await (const frame of stream) if (frame.type === "changed") onSignal();
  },
  onSpaceChange: (listener) => {
    window.addEventListener(SPACE_SELECTED_EVENT, listener);
    return () => window.removeEventListener(SPACE_SELECTED_EVENT, listener);
  },
});
