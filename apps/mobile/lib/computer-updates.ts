import { createComputerUpdates, isUnauthorizedError } from "@rakazo/core";
import { rpc, spaceSelectionSeq, subscribeSpaceSelection } from "./api";
import { subscribeComputerUpdateSignals } from "./api-live";

// A 401 sent before a Space switch belongs to the old Space, not a lost session, and the list
// outlives the switch: report it as transient so it is asked for again.
async function acrossSpaceSwitch<T>(request: () => Promise<T>): Promise<T> {
  const selection = spaceSelectionSeq();
  try {
    return await request();
  } catch (error) {
    if (isUnauthorizedError(error) && selection !== spaceSelectionSeq()) {
      throw new Error("Space changed", { cause: error });
    }
    throw error;
  }
}

export const computerUpdates = createComputerUpdates({
  list: () => acrossSpaceSwitch(() => rpc("computer/updates")),
  start: (botId, action) => rpc(`computer/${action}`, { botId }),
  dismiss: (id) => rpc("computer/dismissUpdate", { id }),
  follow: (onSignal, signal) =>
    acrossSpaceSwitch(() => subscribeComputerUpdateSignals(onSignal, signal)),
  onSpaceChange: (listener) => subscribeSpaceSelection(listener),
});
