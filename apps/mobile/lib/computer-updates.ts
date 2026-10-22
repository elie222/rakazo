import type { ComputerUpdate } from "@rakazo/contracts";
import { createComputerUpdates, isUnauthorizedError } from "@rakazo/core";
import { rpc, spaceSelectionSeq } from "./api";
export const computerUpdates = createComputerUpdates({
  list: async () => {
    const selection = spaceSelectionSeq();
    try {
      return await rpc<ComputerUpdate[]>("computer/updates");
    } catch (error) {
      // A 401 sent before a Space switch belongs to the old Space, not a lost session, and the
      // poller outlives the switch: report it as transient so polling continues.
      if (isUnauthorizedError(error) && selection !== spaceSelectionSeq()) {
        throw new Error("Space changed", { cause: error });
      }
      throw error;
    }
  },
  start: (botId, action) => rpc<ComputerUpdate>(`computer/${action}`, { botId }),
  releaseInterrupted: (id) => rpc("computer/releaseInterrupted", { id, workersStopped: true }),
  dismiss: (id) => rpc("computer/dismissUpdate", { id }),
});
