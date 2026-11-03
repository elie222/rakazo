import { getLogger } from "@rakazo/logging";
import {
  getAccountComputerSettings,
  getComputerProviderSettings,
  updateAccountComputerSettings,
  updateComputerProviderSettings,
} from "../computer-provider-config.js";
import { moveAccountComputers } from "./computer.js";
import type { RouterContext } from "./context.js";

export function computerProviderRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    computerProvider: {
      get: authed.computerProvider.get.handler(({ context }) =>
        getComputerProviderSettings(deps, context.actor),
      ),
      update: authed.computerProvider.update.handler(({ context, input }) =>
        updateComputerProviderSettings(deps, context.actor, input),
      ),
      account: {
        get: authed.computerProvider.account.get.handler(({ context }) =>
          getAccountComputerSettings(deps, context.actor),
        ),
        update: authed.computerProvider.account.update.handler(async ({ context, input }) => {
          const settings = await updateAccountComputerSettings(deps, context.actor, input);
          // Starting desktops can take minutes; the save returns now and a computer not moved
          // here moves at its next run.
          void moveAccountComputers(deps, context.actor).catch((error) =>
            getLogger().warn("computer.move_failed", { error }),
          );
          return settings;
        }),
      },
    },
  };
}
