import { createBotPackagesService } from "../bot-packages.js";
import type { RouterContext } from "./context.js";

export function botPackagesRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  const botPackages = createBotPackagesService(deps);
  return {
    botPackages: {
      preview: authed.botPackages.preview.handler(({ context, input }) =>
        botPackages.preview(context, input),
      ),
      import: authed.botPackages.import.handler(({ context, input }) =>
        botPackages.import(context, input),
      ),
      status: authed.botPackages.status.handler(({ context, input }) =>
        botPackages.status(context, input),
      ),
      recent: authed.botPackages.recent.handler(({ context }) => botPackages.recent(context)),
      forBot: authed.botPackages.forBot.handler(({ context, input }) =>
        botPackages.forBot(context, input),
      ),
      resume: authed.botPackages.resume.handler(({ context, input }) =>
        botPackages.resume(context, input),
      ),
      cancel: authed.botPackages.cancel.handler(({ context, input }) =>
        botPackages.cancel(context, input),
      ),
      activateSkill: authed.botPackages.activateSkill.handler(({ context, input }) =>
        botPackages.activateSkill(context, input),
      ),
      export: authed.botPackages.export.handler(({ context, input }) =>
        botPackages.export(context, input),
      ),
    },
  };
}
