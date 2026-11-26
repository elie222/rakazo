import { randomUUID } from "node:crypto";
import { ProtectedBrowserError } from "@rakazo/adapters";
import { ClientError, deadlineSignal } from "@rakazo/core";
import {
  lockManagedOrganization,
  managedOrganizationId,
  OrganizationAdminRequiredError,
  Prisma,
  runAsSystem,
} from "@rakazo/db";
import { bestEffort, getLogger } from "@rakazo/logging";
import type { RouterContext } from "./context.js";

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
  function listLogins(tx: Prisma.TransactionClient, organizationId: string, loginId?: string) {
    return tx.$queryRaw<
      { id: string; name: string; origin: string; hasSession: boolean; botIds: string[] }[]
    >`
      SELECT login.id, login.name, login.origin, login."sessionCipher" IS NOT NULL AS "hasSession",
        ARRAY(
          SELECT grant_row."botId" FROM organization_login_grants AS grant_row
          JOIN bots AS bot ON bot.id = grant_row."botId"
          WHERE grant_row."loginId" = login.id AND bot."archivedAt" IS NULL
          ORDER BY grant_row."botId"
        ) AS "botIds"
      FROM organization_logins AS login
      WHERE login."organizationId" = ${organizationId}
        ${loginId === undefined ? Prisma.empty : Prisma.sql`AND login.id = ${loginId}`}
      ORDER BY login.name, login.id
    `;
  }

  async function readLogin(tx: Prisma.TransactionClient, organizationId: string, loginId: string) {
    const [login] = await listLogins(tx, organizationId, loginId);
    if (!login) throw new OrganizationLoginNotFoundError();
    return login;
  }

  async function notify(organizationId: string) {
    await bestEffort(
      "publish shared login change",
      deps.events?.publishOrganizationChange?.(organizationId) ?? Promise.resolve(),
    );
  }

  async function change<T>(
    actor: { userId: string; spaceId: string },
    work: (tx: Prisma.TransactionClient, organizationId: string) => Promise<T>,
  ) {
    const { organizationId, value } = await adminOperation(actor, async (tx, organizationId) => ({
      organizationId,
      value: await work(tx, organizationId),
    }));
    await notify(organizationId);
    return value;
  }

  return {
    settings: vault.settings.handler(({ context }) =>
      adminOperation(
        context.actor,
        async (tx, organizationId) => ({
          signInAvailable: Boolean(deps.organizationLoginBrowser),
          logins: await listLogins(tx, organizationId),
          agents: await tx.bot.findMany({
            where: { archivedAt: null, space: { organizationId } },
            select: { id: true, name: true },
            orderBy: [{ name: "asc" }, { id: "asc" }],
          }),
        }),
        false,
      ),
    ),
    signIn: vault.signIn.handler(async ({ context, input, signal: requestSignal }) => {
      const actor = context.actor;
      const { organizationId, login } = await adminOperation(
        actor,
        async (tx, organizationId) => {
          const login = await tx.organizationLogin.findFirst({
            where: { id: input.loginId, organizationId },
            select: { id: true, origin: true, sessionVersion: true },
          });
          if (!login) throw new OrganizationLoginNotFoundError();
          return { organizationId, login };
        },
        false,
      );
      const browser = deps.organizationLoginBrowser;
      if (!browser) throw new ClientError("BAD_REQUEST", "Protected sign-in is unavailable");

      const url = URL.canParse(input.url) ? new URL(input.url) : null;
      if (!url || url.origin !== login.origin || url.username || url.password) {
        throw new ClientError("BAD_REQUEST", "Enter a sign-in page on the saved site");
      }
      const signal = deadlineSignal(100_000, requestSignal);
      let state: Awaited<ReturnType<typeof browser.launch>>["storageState"];
      try {
        ({ storageState: state } = await browser.launch(
          {
            mode: "sign-in",
            url: url.href,
            steps: [
              { kind: "fill", role: "textbox", name: input.usernameLabel, text: input.username },
              { kind: "fill", role: "textbox", name: input.passwordLabel, text: input.password },
              { kind: "click", role: "button", name: input.submitLabel },
              { kind: "wait", role: "heading", name: input.successHeading },
            ],
          },
          signal,
        ));
      } catch (error) {
        if (requestSignal?.aborted) requestSignal.throwIfAborted();
        if (!(error instanceof ProtectedBrowserError)) {
          // Browser errors can contain form values or data from the signed-in page.
          throw new Error("Unexpected protected browser failure");
        }
        getLogger().warn("Protected sign-in failed", {
          organizationId,
          loginId: login.id,
          code: error.code,
        });
        if (error.code === "sign-in-rejected") {
          throw new ClientError("BAD_REQUEST", "The protected sign-in could not finish");
        }
        if (error.code === "timeout") {
          throw new ClientError("SERVICE_UNAVAILABLE", "Protected sign-in timed out");
        }
        if (error.code === "configuration") {
          throw new ClientError("SERVICE_UNAVAILABLE", "Protected sign-in is unavailable");
        }
        throw error;
      }
      const savedState = {
        cookies: state.cookies.filter((cookie) => {
          const host = cookie.domain.startsWith(".") ? cookie.domain.slice(1) : cookie.domain;
          return (
            url.hostname === host ||
            (cookie.domain.startsWith(".") && url.hostname.endsWith(`.${host}`))
          );
        }),
        origins: state.origins.filter((entry) => entry.origin === url.origin),
      };
      if (
        !savedState.cookies.length &&
        !savedState.origins.some((entry) => entry.localStorage.length)
      ) {
        throw new ClientError("BAD_REQUEST", "The site returned no session data");
      }
      const operationId = randomUUID();
      const sealed = await browser.encryption.put(
        JSON.stringify(savedState),
        { ...actor, operationId, traceId: operationId, signal },
        { recordId: login.id },
      );
      return change(actor, async (tx, currentOrganizationId) => {
        if (organizationId !== currentOrganizationId) throw new OrganizationLoginNotFoundError();
        signal.throwIfAborted();
        const { count } = await tx.organizationLogin.updateMany({
          where: { id: login.id, organizationId, sessionVersion: login.sessionVersion },
          data: { sessionCipher: sealed.ciphertext, sessionVersion: { increment: 1 } },
        });
        if (!count)
          throw new ClientError("CONFLICT", "The session changed while you were signing in");
        return readLogin(tx, organizationId, login.id);
      });
    }),
    revokeSession: vault.revokeSession.handler(({ context, input }) =>
      change(context.actor, async (tx, organizationId) => {
        const { count } = await tx.organizationLogin.updateMany({
          where: { id: input.loginId, organizationId },
          data: { sessionCipher: null, sessionVersion: { increment: 1 } },
        });
        if (!count) throw new OrganizationLoginNotFoundError();
        return readLogin(tx, organizationId, input.loginId);
      }),
    ),
    list: vault.list.handler(({ context }) => adminOperation(context.actor, listLogins, false)),
    create: vault.create.handler(({ context, input }) =>
      change(context.actor, async (tx, organizationId) => {
        const botIds = await validateAgents(tx, organizationId, input.botIds);
        const row = await tx.organizationLogin.create({
          data: {
            organizationId,
            name: input.name,
            origin: input.origin,
            grants: { create: botIds.map((botId) => ({ botId })) },
          },
          select: { id: true },
        });
        return readLogin(tx, organizationId, row.id);
      }),
    ),
    setAgents: vault.setAgents.handler(({ context, input }) =>
      change(context.actor, async (tx, organizationId) => {
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
        return readLogin(tx, organizationId, login.id);
      }),
    ),
    remove: vault.remove.handler(({ context, input }) =>
      change(context.actor, async (tx, organizationId) => {
        const { count } = await tx.organizationLogin.deleteMany({
          where: { id: input.loginId, organizationId },
        });
        if (!count) throw new OrganizationLoginNotFoundError();
        return { ok: true as const };
      }),
    ),
  };
}
