import { createComputerUpdates, isUnauthorizedError } from "@rakazo/core";
import { rpc, spaceSelectionSeq, subscribeSpaceSelection } from "./api";

export const computerUpdates = createComputerUpdates({
  list: async () => {
    const selection = spaceSelectionSeq();
    try {
      return await rpc("computer/updates");
    } catch (error) {
      // A 401 sent before a Space switch belongs to the old Space, not a lost session, and the
      // store outlives the switch: report it as transient so it is retried.
      if (isUnauthorizedError(error) && selection !== spaceSelectionSeq()) {
        throw new Error("Space changed", { cause: error });
      }
      throw error;
    }
  },
  start: (botId, action) => rpc(`computer/${action}`, { botId }),
  dismiss: (id) => rpc("computer/dismissUpdate", { id }),
  onSpaceChange: (listener) => subscribeSpaceSelection(listener),
});
