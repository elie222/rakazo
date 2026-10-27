import { ORPCError } from "@orpc/server";
import {
  createGlobalBotRepos,
  IsolationError,
  requireDeploymentCatalogAdmin,
  requireSpaceOwnerRole,
} from "@rakazo/db";
import type { RouterContext } from "./context.js";

function mapCatalogError(error: unknown): unknown {
  if (error instanceof IsolationError) {
    if (error.message === "Deployment admin required" || error.message === "Space owner required") {
      return new ORPCError("FORBIDDEN", { message: error.message });
    }
    if (
      error.message === "Global bot slug already used" ||
      error.message === "Connector slug already used"
    ) {
      return new ORPCError("CONFLICT", { message: error.message });
    }
  }
  return error;
}

export function globalBotsRoutes(ctx: RouterContext) {
  const { deps, authed } = ctx;
  const catalog = createGlobalBotRepos(deps.prisma);

  const asAdmin = async <T>(actor: Parameters<typeof requireDeploymentCatalogAdmin>[1], run: () => Promise<T>) => {
    try {
      await requireDeploymentCatalogAdmin(deps.prisma, actor);
      return await run();
    } catch (error) {
      throw mapCatalogError(error);
    }
  };

  const asSpaceOwner = async <T>(
    actor: Parameters<typeof requireSpaceOwnerRole>[0],
    run: () => Promise<T>,
  ) => {
    try {
      await requireSpaceOwnerRole(actor);
      return await run();
    } catch (error) {
      throw mapCatalogError(error);
    }
  };

  return {
    globalBots: {
      listPublished: authed.globalBots.listPublished.handler(async () =>
        catalog.listPublishedGlobalBots(),
      ),
      get: authed.globalBots.get.handler(async ({ input }) => {
        try {
          return await catalog.getGlobalBot(input.globalBotId, { publishedOnly: true });
        } catch (error) {
          throw mapCatalogError(error);
        }
      }),
      admin: {
        create: authed.globalBots.admin.create.handler(async ({ context, input }) =>
          asAdmin(context.actor, () => catalog.createGlobalBot(input)),
        ),
        update: authed.globalBots.admin.update.handler(async ({ context, input }) =>
          asAdmin(context.actor, () => catalog.updateGlobalBot(input)),
        ),
        publish: authed.globalBots.admin.publish.handler(async ({ context, input }) =>
          asAdmin(context.actor, () =>
            catalog.publishGlobalBot(input.globalBotId, input.published),
          ),
        ),
        setConnectors: authed.globalBots.admin.setConnectors.handler(async ({ context, input }) =>
          asAdmin(context.actor, () =>
            catalog.setGlobalBotConnectors(input.globalBotId, input.connectorIds),
          ),
        ),
      },
    },
    connectors: {
      admin: {
        list: authed.connectors.admin.list.handler(async ({ context }) =>
          asAdmin(context.actor, () => catalog.listConnectors()),
        ),
        get: authed.connectors.admin.get.handler(async ({ context, input }) =>
          asAdmin(context.actor, () => catalog.getConnector(input.connectorId)),
        ),
        create: authed.connectors.admin.create.handler(async ({ context, input }) =>
          asAdmin(context.actor, () => catalog.createConnector(input)),
        ),
        update: authed.connectors.admin.update.handler(async ({ context, input }) =>
          asAdmin(context.actor, () => catalog.updateConnector(input)),
        ),
        remove: authed.connectors.admin.remove.handler(async ({ context, input }) => {
          await asAdmin(context.actor, () => catalog.removeConnector(input.connectorId));
          return { ok: true as const };
        }),
      },
    },
    spaceGlobalBots: {
      list: authed.spaceGlobalBots.list.handler(async ({ context }) =>
        catalog.listSpaceGlobalBots(context.actor),
      ),
      setEnabled: authed.spaceGlobalBots.setEnabled.handler(async ({ context, input }) =>
        asSpaceOwner(context.actor, () =>
          catalog.setSpaceGlobalBotEnabled(context.actor, input.globalBotId, input.enabled),
        ),
      ),
    },
    spacePermissions: {
      get: authed.spacePermissions.get.handler(async ({ context }) =>
        asSpaceOwner(context.actor, () => catalog.getSpacePermissions(context.actor)),
      ),
      set: authed.spacePermissions.set.handler(async ({ context, input }) =>
        asSpaceOwner(context.actor, () => catalog.setSpacePermissions(context.actor, input)),
      ),
    },
  };
}
