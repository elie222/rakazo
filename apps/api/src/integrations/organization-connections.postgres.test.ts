import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import type { ManagedConnectorProvider } from "@rakazo/adapter-kit";
import { ConnectorRegistry } from "@rakazo/adapters";
import { ORGANIZATION_CONNECTION_NAME_TAKEN } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router.js";

const enabled = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);

describe.skipIf(!enabled)("organization app connections (PostgreSQL)", () => {
  let db: ReturnType<typeof createDb>;
  let prisma: PrismaClient;
  const suffix = randomUUID();
  const team = `team-${suffix}`;
  const other = `other-${suffix}`;
  const main = `main-${suffix}`;
  const second = `second-${suffix}`;
  const outside = `outside-${suffix}`;
  const people = ["owner", "admin", "member", "guest", "outsider"] as const;
  const user = (role: (typeof people)[number]) => `${role}-${suffix}`;
  const identity = (role: (typeof people)[number], spaceId = main) => ({
    userId: user(role),
    spaceId,
    email: `${user(role)}@example.test`,
    isDeploymentOwner: false,
  });
  const connector: ManagedConnectorProvider = {
    describe: () => ({
      id: "fixture",
      contractVersion: "1",
      adapterVersion: "1",
      capabilities: { discover: true, oauth: true, secretsBrokered: true },
    }),
    discoverTools: async (context) =>
      (context.connectedConnections ?? []).map((row) => ({
        name: "list_items",
        description: row.displayName,
        inputSchema: { type: "object", properties: {} },
        readOnly: true,
      })),
    execute: async function* () {},
    catalog: async () => [],
    begin: vi.fn<ManagedConnectorProvider["begin"]>(async () => ({
      authorizationUrl: "https://authorization.example.test/",
      state: "fixture-request",
    })),
    complete: async () => ({ connectionRef: "fixture-account" }),
    listConnectedExternalIds: async () => [],
    listConnectedRefs: vi.fn(async () => ["fixture-account"]),
    connectionReady: async () => true,
    connectedAccountIdentity: vi.fn(async () => undefined as string | undefined),
    resolveConnectedAccountId: vi.fn<
      NonNullable<ManagedConnectorProvider["resolveConnectedAccountId"]>
    >(async () => "fixture-account"),
    revoke: vi.fn(async () => {}),
  };
  const publishSpaceChange = vi.fn(async () => {});
  const client = (role: (typeof people)[number], spaceId = main) =>
    createRouterClient(
      createRouter({
        prisma,
        connectors: new ConnectorRegistry([connector]),
        jobs: { enqueueIn: vi.fn(), cancelIn: vi.fn() },
        events: { publishSpaceChange },
        env: { webOrigin: "https://rakazo.example.test" },
      } as unknown as RouterDeps),
      { context: { actor: identity(role, spaceId) } },
    ).connections;
  const request = { connectorId: "fixture", provider: "mail", displayName: "Shared inbox" };
  let sharedId: string;

  beforeAll(() =>
    runAsSystem("organization connections fixtures", async () => {
      db = createDb(process.env.DATABASE_URL!);
      prisma = db.prisma;
      for (const id of [team, other])
        await prisma.organization.create({
          data: { id, name: id, slug: id, createdAt: new Date() },
        });
      for (const [id, organizationId, isDefault] of [
        [main, team, true],
        [second, team, false],
        [outside, other, true],
      ] as const)
        await prisma.space.create({ data: { id, organizationId, name: id, isDefault } });
      for (const role of people) {
        const userId = user(role);
        await prisma.user.create({ data: { id: userId, email: identity(role).email, name: role } });
        await prisma.member.create({
          data: {
            id: userId,
            organizationId: role === "outsider" ? other : team,
            userId,
            role: role === "outsider" ? "owner" : role,
            createdAt: new Date(),
          },
        });
      }
      await prisma.spaceMember.upsert({
        where: { spaceId_userId: { spaceId: main, userId: user("guest") } },
        create: {
          id: `invite-${suffix}`,
          organizationId: team,
          spaceId: main,
          userId: user("guest"),
          createdAt: new Date(),
        },
        update: {},
      });
      await prisma.secret.create({
        data: {
          id: `credential-${suffix}`,
          organizationId: team,
          kind: "oauth",
          ciphertext: "fixture",
        },
      });
    }),
  );

  afterAll(() =>
    runAsSystem("remove organization connections fixtures", async () => {
      if (!prisma) return;
      await prisma.organization.deleteMany({ where: { id: { in: [team, other] } } });
      await prisma.user.deleteMany({ where: { id: { in: people.map(user) } } });
      await prisma.$disconnect();
      await db.pool.end();
    }),
  );

  it("starts one authorization and finishes it as an admin in another Space", async () => {
    const started = await client("owner").beginForOrganization(request);
    sharedId = started.connectionId;
    expect(await client("admin", second).complete({ connectionId: sharedId })).toMatchObject({
      status: "connected",
      organization: true,
      manageable: true,
    });
    expect(connector.begin).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ organizationId: team }),
    );
    expect(connector.resolveConnectedAccountId).toHaveBeenCalledWith(
      user("admin"),
      "mail",
      "fixture-request",
      [],
      second,
      team,
    );
    expect(publishSpaceChange).toHaveBeenCalledWith(second, "integrations");
  });

  it("lets members use it in every Space alongside their own accounts", async () => {
    for (const spaceId of [main, second]) {
      expect(await client("member", spaceId).list()).toMatchObject([
        { id: sharedId, organization: true, manageable: false },
      ]);
      expect(
        await client("member", spaceId).tools({ connectorId: "fixture", provider: "mail" }),
      ).toMatchObject([{ name: "list_items", description: "Shared inbox" }]);
    }
    for (const displayName of ["First inbox", "Second inbox"])
      await client("member", second).begin({ ...request, displayName });
    expect(await client("member", second).list()).toHaveLength(3);
    expect(await client("member").list()).toHaveLength(1);
  });

  it("keeps organization rows inaccessible to guests and other organizations at the database", async () => {
    for (const actor of [identity("guest"), identity("outsider", outside)]) {
      const rows = await runAsTenant(actor, () =>
        prisma.connection.findMany({ where: { id: sharedId } }),
      );
      expect(rows).toEqual([]);
    }
  });

  it("shares a provider health lookup between simultaneous list requests", async () => {
    const lookup = vi.mocked(connector.listConnectedRefs!);
    lookup.mockClear();
    const member = client("member", second);
    await Promise.all([member.list(), member.list()]);
    expect(lookup).toHaveBeenCalledTimes(1);
  });

  it("lets a member write a shared credential during use", async () => {
    const updated = await runAsTenant(identity("member", second), () =>
      prisma.secret.update({
        where: { id: `credential-${suffix}` },
        data: { ciphertext: "refreshed" },
      }),
    );
    expect(updated.ciphertext).toBe("refreshed");
  });

  it("refuses member management of a visible organization connection", async () => {
    const member = client("member", second);
    for (const operation of [
      () => member.beginForOrganization(request),
      () => member.rename({ connectionId: sharedId, displayName: "Changed" }),
      () => member.revoke({ connectionId: sharedId }),
      () => member.complete({ connectionId: sharedId }),
      () => member.reconnectOrganization({ connectionId: sharedId }),
    ])
      await expect(operation()).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("adds a distinct account to the same app with a different label", async () => {
    const admin = client("admin", second);
    const { connectionId } = await admin.beginForOrganization({ ...request, provider: "MAIL" });
    vi.mocked(connector.resolveConnectedAccountId!).mockResolvedValueOnce("fixture-account-2");
    const completed = await admin.complete({ connectionId });
    expect(completed).toMatchObject({
      id: connectionId,
      status: "connected",
      displayName: "Shared inbox 2",
    });
    vi.mocked(connector.listConnectedRefs!).mockResolvedValueOnce([
      "fixture-account",
      "fixture-account-2",
    ]);
    expect((await client("member", second).list()).map((row) => row.id)).toEqual(
      expect.arrayContaining([sharedId, connectionId]),
    );
    await admin.revoke({ connectionId });
    expect(connector.revoke).toHaveBeenCalledExactlyOnceWith(
      "fixture-account-2",
      expect.objectContaining({ organizationId: team }),
    );
    expect(await admin.list()).toContainEqual(
      expect.objectContaining({ id: sharedId, status: "connected" }),
    );
    vi.mocked(connector.revoke).mockClear();
  });

  it("retires a duplicate row for the exact account ref without revoking it", async () => {
    const admin = client("admin", second);
    const { connectionId } = await admin.beginForOrganization({ ...request, provider: "MAIL" });
    expect(await admin.complete({ connectionId })).toMatchObject({
      id: sharedId,
      status: "connected",
    });
    expect(await admin.list()).toContainEqual(
      expect.objectContaining({ id: connectionId, status: "revoked" }),
    );
    expect(connector.revoke).not.toHaveBeenCalled();
  });

  it("skips app-wide revoke when a differently cased sibling owns an account", async () => {
    const admin = client("admin", second);
    const { connectionId } = await admin.beginForOrganization({ ...request, provider: "MAIL" });
    await runAsSystem("legacy organization connection fixture", () =>
      prisma.connection.update({
        where: { id: connectionId },
        data: { status: "connected", providerRef: "MAIL" },
      }),
    );
    await admin.revoke({ connectionId });
    expect(connector.revoke).not.toHaveBeenCalled();
    expect(await admin.list()).toContainEqual(
      expect.objectContaining({ id: sharedId, status: "connected" }),
    );
  });

  it("keeps the existing account when separate authorizations verify the same identity", async () => {
    const admin = client("admin", second);
    const { connectionId } = await admin.beginForOrganization(request);
    vi.mocked(connector.resolveConnectedAccountId!).mockResolvedValueOnce("fixture-duplicate");
    vi.mocked(connector.connectedAccountIdentity!)
      .mockResolvedValueOnce("mailbox@example.test")
      .mockResolvedValueOnce("mailbox@example.test");
    expect(await admin.complete({ connectionId })).toMatchObject({
      id: sharedId,
      status: "connected",
    });
    expect(await admin.list()).toContainEqual(
      expect.objectContaining({ id: connectionId, status: "revoked" }),
    );
  });

  it("detects a conflicting rename in the owning organization", async () => {
    const admin = client("admin", second);
    await client("outsider", outside).beginForOrganization(request);
    const { connectionId } = await admin.beginForOrganization({
      ...request,
      provider: "tracker",
      displayName: "Shared tracker",
    });
    await expect(admin.rename({ connectionId, displayName: "shared INBOX" })).rejects.toMatchObject(
      {
        code: ORGANIZATION_CONNECTION_NAME_TAKEN,
      },
    );
  });

  it("preserves the shared row when starting a replacement sign-in fails", async () => {
    vi.mocked(connector.listConnectedRefs!).mockResolvedValueOnce([]);
    vi.mocked(connector.begin).mockRejectedValueOnce(new Error("Provider unavailable"));
    const admin = client("admin", second);
    await expect(admin.reconnectOrganization({ connectionId: sharedId })).rejects.toThrow();
    expect(await admin.list()).toContainEqual(
      expect.objectContaining({ id: sharedId, status: "connected", displayName: "Shared inbox" }),
    );
    expect(connector.revoke).not.toHaveBeenCalled();
  });

  it("reconnects the shared app without removing a member's accounts", async () => {
    vi.mocked(connector.listConnectedRefs!).mockResolvedValueOnce([]);
    vi.mocked(connector.begin).mockResolvedValueOnce({
      authorizationUrl: "https://authorization.example.test/",
      state: "replacement-request",
    });
    const admin = client("admin", second);
    const { connectionId } = await admin.reconnectOrganization({ connectionId: sharedId });
    expect(connectionId).toBe(sharedId);
    expect(connector.revoke).toHaveBeenCalledWith(
      "fixture-account",
      expect.objectContaining({ organizationId: team }),
    );
    expect(
      (await client("member", second).list()).filter((row) => row.status !== "revoked"),
    ).toHaveLength(4);
  });

  it("finishes an existing sign-in when an admin reconnects a pending account", async () => {
    const admin = client("admin", second);
    const { connectionId } = await admin.beginForOrganization({
      ...request,
      provider: "calendar",
      displayName: "Shared calendar",
    });
    vi.mocked(connector.begin).mockClear();
    await expect(admin.reconnectOrganization({ connectionId })).resolves.toEqual({
      connectionId,
      authorizationUrl: null,
    });
    expect(connector.begin).not.toHaveBeenCalled();
  });
  it("allows just one overlapping shared sign-in without request correlation", async () => {
    const snapshot = vi.fn(async () => []);
    connector.listAccountsBeforeSignIn = snapshot;
    const app = { ...request, provider: "fixture-hosted", displayName: "Hosted" };
    vi.mocked(connector.begin).mockResolvedValueOnce({
      authorizationUrl: "https://authorization.example.test/",
      state: app.provider,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    try {
      await client("owner").beginForOrganization(app);
      await expect(client("admin", second).beginForOrganization(app)).rejects.toMatchObject({
        code: "CONFLICT",
      });
      expect(snapshot).toHaveBeenCalledTimes(1);
    } finally {
      delete connector.listAccountsBeforeSignIn;
    }
  });

  it("excludes remote accounts that existed before issuing the shared sign-in link", async () => {
    connector.listAccountsBeforeSignIn = async () => ["orphan"];
    const app = { ...request, provider: "fixture-snapshot", displayName: "Snapshot" };
    vi.mocked(connector.begin).mockResolvedValueOnce({
      authorizationUrl: "https://authorization.example.test/",
      state: app.provider,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const resolve = vi.mocked(connector.resolveConnectedAccountId!);
    resolve.mockImplementationOnce(async (_user, _slug, _ref, excluded) =>
      excluded?.includes("orphan") ? undefined : "orphan",
    );
    try {
      const admin = client("admin", second);
      const { connectionId } = await admin.beginForOrganization(app);
      expect(await admin.complete({ connectionId })).toMatchObject({ status: "pending" });
      expect(resolve).toHaveBeenLastCalledWith(
        expect.any(String),
        app.provider,
        app.provider,
        ["orphan"],
        second,
        team,
      );
    } finally {
      delete connector.listAccountsBeforeSignIn;
    }
  });

  it("rejects a replacement hosted sign-in when the previous link has no recorded expiry", async () => {
    connector.listAccountsBeforeSignIn = async () => [];
    const app = { ...request, provider: "fixture-unknown-expiry", displayName: "Unknown expiry" };
    const link = {
      authorizationUrl: "https://authorization.example.test/",
      state: app.provider,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    vi.mocked(connector.begin).mockResolvedValueOnce(link).mockResolvedValueOnce(link);
    try {
      const admin = client("admin", second);
      const { connectionId } = await admin.beginForOrganization(app);
      await admin.revoke({ connectionId });
      await runAsSystem("legacy hosted sign-in fixture", () =>
        prisma.connection.update({
          where: { id: connectionId },
          data: { metadata: {}, updatedAt: new Date(0) },
        }),
      );
      await expect(admin.beginForOrganization(app)).rejects.toMatchObject({
        code: "SERVICE_UNAVAILABLE",
      });
    } finally {
      delete connector.listAccountsBeforeSignIn;
    }
  });

  it("waits for a removed hosted sign-in link to expire before issuing another one", async () => {
    connector.listAccountsBeforeSignIn = async () => [];
    const app = { ...request, provider: "fixture-cancelled-link", displayName: "Cancelled link" };
    const link = {
      authorizationUrl: "https://authorization.example.test/",
      state: app.provider,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    vi.mocked(connector.begin).mockResolvedValueOnce(link).mockResolvedValueOnce(link);
    try {
      const admin = client("admin", second);
      const { connectionId } = await admin.beginForOrganization(app);
      await admin.revoke({ connectionId });
      await expect(admin.beginForOrganization(app)).rejects.toMatchObject({ code: "CONFLICT" });
    } finally {
      delete connector.listAccountsBeforeSignIn;
    }
  });
});
