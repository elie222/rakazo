import { ClientError } from "@rakazo/core";
import type { Prisma } from "@rakazo/db";
import { managedOrganizationId, OrganizationAdminRequiredError, runAsSystem } from "@rakazo/db";
import type { RouterContext } from "./context.js";

const loginSelect = {
  id: true,
  name: true,
  origin: true,
  grants: { select: { botId: true }, orderBy: { botId: "asc" } },
} satisfies Prisma.OrganizationLoginSelect;

function loginDto({
  grants,
  ...login
}: Prisma.OrganizationLoginGetPayload<{
  select: typeof loginSelect;
}>) {
  return { ...login, botIds: grants.map(({ botId }) => botId) };
}

class InvalidOrganizationLoginAgentsError extends ClientError {
  constructor() {
    super("BAD_REQUEST", "Choose active agents in this organization");
  }
}

class OrganizationLoginNotFoundError extends ClientError {
  constructor() {
    super("NOT_FOUND", "Organization login not found");
  }
}

async function validateAgents(tx: Prisma.TransactionClient, organizationId: string, ids: string[]) {
  const botIds = [...new Set(ids)];
  const count = await tx.bot.count({
    where: { id: { in: botIds }, archivedAt: null, space: { organizationId } },
  });
  if (count !== botIds.length) {
    throw new InvalidOrganizationLoginAgentsError();
  }
  return botIds;
}

export function organizationVaultRoutes({ deps, authed }: RouterContext) {
  const vault = authed.organizations.vault;
  function adminOperation<T>(
    actor: { userId: string; spaceId: string },
    work: (tx: Prisma.TransactionClient, organizationId: string) => Promise<T>,
  ) {
    return runAsSystem("manage the vault of the active organization", () =>
      deps.prisma.$transaction(async (tx) => {
        const organizationId = await managedOrganizationId(tx, actor);
        if (!organizationId) throw new OrganizationAdminRequiredError();
        return work(tx, organizationId);
      }),
    );
  }
  return {
    list: vault.list.handler(({ context }) =>
      adminOperation(context.actor, async (tx, organizationId) => {
        const rows = await tx.organizationLogin.findMany({
          where: { organizationId },
          select: loginSelect,
          orderBy: [{ name: "asc" }, { id: "asc" }],
        });
        return rows.map(loginDto);
      }),
    ),
    create: vault.create.handler(({ context, input }) =>
      adminOperation(context.actor, async (tx, organizationId) => {
        const botIds = await validateAgents(tx, organizationId, input.botIds);
        const row = await tx.organizationLogin.create({
          data: {
            organizationId,
            name: input.name,
            origin: input.origin,
            grants: { create: botIds.map((botId) => ({ botId })) },
          },
          select: loginSelect,
        });
        return loginDto(row);
      }),
    ),
    setAgents: vault.setAgents.handler(({ context, input }) =>
      adminOperation(context.actor, async (tx, organizationId) => {
        const [login] = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM organization_logins
          WHERE id = ${input.loginId} AND "organizationId" = ${organizationId}
          FOR UPDATE`;
        if (!login) throw new OrganizationLoginNotFoundError();
        const botIds = await validateAgents(tx, organizationId, input.botIds);
        await tx.organizationLoginGrant.deleteMany({
          where: { loginId: login.id, botId: { notIn: botIds } },
        });
        await tx.organizationLoginGrant.createMany({
          data: botIds.map((botId) => ({ loginId: login.id, botId })),
          skipDuplicates: true,
        });
        return loginDto(
          await tx.organizationLogin.findUniqueOrThrow({
            where: { id: login.id },
            select: loginSelect,
          }),
        );
      }),
    ),
    remove: vault.remove.handler(({ context, input }) =>
      adminOperation(context.actor, async (tx, organizationId) => {
        const { count } = await tx.organizationLogin.deleteMany({
          where: { id: input.loginId, organizationId },
        });
        if (!count) throw new OrganizationLoginNotFoundError();
        return { ok: true as const };
      }),
    ),
  };
}
