import { ClientError } from "@rakazo/core";
import {
  lockManagedOrganization,
  managedOrganizationId,
  OrganizationAdminRequiredError,
  Prisma,
  runAsSystem,
} from "@rakazo/db";
import type { RouterContext } from "./context.js";

const loginSelect = {
  id: true,
  name: true,
  origin: true,
  grants: {
    where: { bot: { archivedAt: null } },
    select: { botId: true },
    orderBy: { botId: "asc" },
  },
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

async function validateAgents(
  tx: Prisma.TransactionClient,
  organizationId: string,
  ids: string[],
  existing: ReadonlySet<string> = new Set(),
) {
  const botIds = [...new Set(ids)];
  if (botIds.length === 0) return botIds;
  const active = await tx.$queryRaw<{ id: string }[]>`
    SELECT bot.id FROM bots AS bot
    JOIN spaces AS space ON space.id = bot."spaceId"
    WHERE bot.id IN (${Prisma.join(botIds)}) AND bot."archivedAt" IS NULL
      AND space."organizationId" = ${organizationId}
    ORDER BY bot.id
    FOR SHARE OF bot
  `;
  const activeIds = new Set(active.map(({ id }) => id));
  if (botIds.some((id) => !activeIds.has(id) && !existing.has(id))) {
    throw new InvalidOrganizationLoginAgentsError();
  }
  return [...activeIds];
}

export function organizationVaultRoutes({ deps, authed }: RouterContext) {
  const vault = authed.organizations.vault;
  function adminOperation<T>(
    actor: { userId: string; spaceId: string },
    work: (tx: Prisma.TransactionClient, organizationId: string) => Promise<T>,
    write = true,
  ) {
    return runAsSystem("manage the vault of the active organization", () =>
      deps.prisma.$transaction(async (tx) => {
        const organizationId = await (write ? lockManagedOrganization : managedOrganizationId)(
          tx,
          actor,
        );
        if (!organizationId) throw new OrganizationAdminRequiredError();
        return work(tx, organizationId);
      }),
    );
  }
  return {
    list: vault.list.handler(({ context }) =>
      adminOperation(
        context.actor,
        async (tx, organizationId) => {
          const rows = await tx.organizationLogin.findMany({
            where: { organizationId },
            select: loginSelect,
            orderBy: [{ name: "asc" }, { id: "asc" }],
          });
          return rows.map(loginDto);
        },
        false,
      ),
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
        const existing = await tx.organizationLoginGrant.findMany({
          where: { loginId: login.id },
          select: { botId: true },
        });
        const botIds = await validateAgents(
          tx,
          organizationId,
          input.botIds,
          new Set(existing.map(({ botId }) => botId)),
        );
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
