import { createComputerUpdates } from "@rakazo/core";
import { rpc } from "./rpc";
export const computerUpdates = createComputerUpdates({
  list: () => rpc.computer.updates(),
  start: (botId) => rpc.computer.restart({ botId }),
  dismiss: (id) => rpc.computer.dismissUpdate({ id }),
});
