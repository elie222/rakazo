import { createComputerUpdates } from "@rakazo/core";
import { rpc } from "./rpc";
export const computerUpdates = createComputerUpdates({
  list: () => rpc.computer.updates(),
  start: (botId, options) => rpc.computer.restart({ botId, ...options }),
  dismiss: (id) => rpc.computer.dismissUpdate({ id }),
});
