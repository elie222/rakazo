import { randomUUID } from "node:crypto";
import { createRouterClient } from "@orpc/server";
import type { ManagedConnectorProvider } from "@rakazo/adapter-kit";
import { ConnectorRegistry, retryConnectionCleanup } from "@rakazo/adapters";
import { ORGANIZATION_CONNECTION_NAME_TAKEN } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { createDb, runAsSystem, runAsTenant } from "@rakazo/db";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { deleteOrganization } from "../account/account-deletion.js";
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
  const enqueueIn = vi.fn();
  const client = (role: (typeof people)[number], spaceId = main) =>
    createRouterClient(
      createRouter({
        prisma,
        connectors: new ConnectorRegistry([connector]),
        jobs: { enqueueIn, cancelIn: vi.fn() },
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

  it("cleans up an account created after its shared sign-in was cancelled without another poll", async () => {
    const admin = client("admin", second);
    const hosted = { ...request, provider: "hosted-mail" };
    const existing = await admin.beginForOrganization(hosted);
    vi.mocked(connector.resolveConnectedAccountId!).mockResolvedValueOnce("established-account");
    await admin.complete(existing);
    const expiresAt = new Date(Date.now() + 600_000).toISOString();
    const list = vi.fn(async () => ["established-account"]);
    connector.listAccountsBeforeSignIn = list;
    const revoke = vi.mocked(connector.revoke);
    revoke.mockClear();
    enqueueIn.mockClear();
    vi.mocked(connector.begin).mockResolvedValueOnce({
      authorizationUrl: "https://authorization.example.test/",
      state: hosted.provider,
      expiresAt,
    });
    try {
      const { connectionId } = await admin.beginForOrganization(hosted);
      await admin.revoke({ connectionId });
      expect(revoke).not.toHaveBeenCalled();
      const scheduled = enqueueIn.mock.calls[0]?.[1];
      expect(scheduled).toMatchObject({
        name: "connection.hosted-sign-in-cleanup",
        availableAt: new Date(expiresAt),
        payload: { connectionId, organizationId: team },
      });
      await runAsSystem("expire cancelled sign-in fixture", async () => {
        await prisma.connection.update({
          where: { id: connectionId },
          data: {
            metadata: {
              expiresAt: new Date(0).toISOString(),
              priorAccountIds: ["established-account"],
            },
          },
        });
        list.mockResolvedValueOnce(["established-account", "cancelled-account"]);
        await retryConnectionCleanup(
          {
            prisma,
            connectors: new ConnectorRegistry([connector]),
            jobs: { enqueue: vi.fn() },
          },
          scheduled.payload,
        );
      });
      expect(revoke).toHaveBeenCalledExactlyOnceWith(
        "cancelled-account",
        expect.objectContaining({ organizationId: team }),
      );
      await admin.revoke(existing);
    } finally {
      delete connector.listAccountsBeforeSignIn;
      revoke.mockClear();
    }
  });

  it("allows a fresh sign-in after an old cancelled link expires without touching its accounts", async () => {
    const admin = client("admin", second);
    const hosted = { ...request, provider: "legacy-hosted-mail" };
    const oldId = randomUUID();
    const old = new Date(Date.now() - 120_000);
    await runAsSystem("insert expired legacy sign-in fixture", () =>
      prisma.connection.create({
        data: {
          id: oldId,
          organizationId: team,
          connectorId: request.connectorId,
          provider: hosted.provider,
          providerRef: hosted.provider,
          status: "revoked",
          displayName: "Cancelled legacy sign-in",
          metadata: { state: hosted.provider, attempt: "fixture-attempt" },
          updatedAt: old,
        },
      }),
    );
    Object.assign(connector, { legacySignInLifetimeMs: 60_000 });
    connector.listAccountsBeforeSignIn = vi.fn(async () => ["old-unknown-account"]);
    const revoke = vi.mocked(connector.revoke);
    revoke.mockClear();
    vi.mocked(connector.begin).mockResolvedValueOnce({
      authorizationUrl: "https://authorization.example.test/",
      state: hosted.provider,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    try {
      const { connectionId } = await admin.beginForOrganization(hosted);
      const row = await runAsSystem("inspect fresh sign-in fixture", () =>
        prisma.connection.findUniqueOrThrow({ where: { id: connectionId } }),
      );
      expect(row.metadata).toMatchObject({ priorAccountIds: ["old-unknown-account"] });
      expect(revoke).not.toHaveBeenCalled();
      await admin.revoke({ connectionId });
    } finally {
      Reflect.deleteProperty(connector, "legacySignInLifetimeMs");
      delete connector.listAccountsBeforeSignIn;
    }
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
  it("preserves a pending shared sign-in when identity lookup fails during reconnect", async () => {
    const admin = client("admin", second);
    const { connectionId } = await admin.beginForOrganization({
      ...request,
      displayName: "Pending shared inbox",
    });
    const read = () =>
      runAsSystem("read the pending sign-in fixture", () =>
        prisma.connection.findUniqueOrThrow({ where: { id: connectionId } }),
      );
    const original = await read();
    vi.mocked(connector.resolveConnectedAccountId!).mockResolvedValueOnce("pending-account");
    vi.mocked(connector.connectedAccountIdentity!).mockRejectedValueOnce(
      new Error("provider unavailable"),
    );
    vi.mocked(connector.begin).mockClear();
    await expect(admin.reconnectOrganization({ connectionId })).rejects.toMatchObject({
      code: "CONFLICT",
    });
    expect(await read()).toEqual(original);
    expect(connector.begin).not.toHaveBeenCalled();
    await admin.revoke({ connectionId });
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

  it.each(["complete", "begin"] as const)(
    "retires an expired shared sign-in through %s without touching the existing account",
    async (entryPoint) => {
      const app = {
        ...request,
        provider: `fixture-expired-${entryPoint}`,
        displayName: "Expired link",
      };
      const admin = client("admin", second);
      const owner = client("owner");
      const existing = await owner.beginForOrganization(app);
      vi.mocked(connector.resolveConnectedAccountId!).mockResolvedValueOnce("known-mailbox");
      await owner.complete({ connectionId: existing.connectionId });

      const expiresAt = new Date(Date.now() + 60_000).toISOString();
      const link = {
        authorizationUrl: "https://authorization.example.test/",
        state: app.provider,
        expiresAt,
      };
      const resolve = vi.mocked(connector.resolveConnectedAccountId!);
      connector.listAccountsBeforeSignIn = async () => ["known-mailbox"];
      vi.mocked(connector.begin).mockResolvedValueOnce(link);
      try {
        const { connectionId } = await admin.beginForOrganization(app);
        resolve.mockImplementationOnce(async (_user, _slug, _ref, excluded) =>
          excluded?.includes("known-mailbox") ? undefined : "known-mailbox",
        );
        expect(await admin.complete({ connectionId, code: "unverified" })).toMatchObject({
          status: "pending",
        });
        const expiry = new Date(0);
        await runAsSystem("expire the hosted sign-in fixture", () =>
          prisma.connection.update({
            where: { id: connectionId },
            data: {
              metadata: { expiresAt: expiry.toISOString(), priorAccountIds: ["known-mailbox"] },
            },
          }),
        );

        vi.mocked(connector.revoke).mockClear();
        if (entryPoint === "complete") {
          expect(await admin.complete({ connectionId })).toMatchObject({ status: "revoked" });
        }
        vi.mocked(connector.begin).mockResolvedValueOnce(link);
        expect(await owner.beginForOrganization(app)).toMatchObject({
          authorizationUrl: link.authorizationUrl,
        });
        expect(await admin.complete({ connectionId })).toMatchObject({ status: "revoked" });
        expect(enqueueIn).toHaveBeenCalledWith(
          expect.anything(),
          expect.objectContaining({
            name: "connection.hosted-sign-in-cleanup",
            availableAt: expiry,
            payload: expect.objectContaining({ organizationId: team, connectionId }),
          }),
        );
        expect(await owner.complete({ connectionId: existing.connectionId })).toMatchObject({
          status: "connected",
        });
        expect(connector.revoke).not.toHaveBeenCalled();
      } finally {
        delete connector.listAccountsBeforeSignIn;
      }
    },
  );

  it("waits for a recently cancelled legacy link without a recorded expiry", async () => {
    connector.listAccountsBeforeSignIn = async () => [];
    Object.assign(connector, { legacySignInLifetimeMs: 60_000 });
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
          data: { metadata: { state: app.provider, attempt: "fixture-attempt" } },
        }),
      );
      await expect(admin.beginForOrganization(app)).rejects.toMatchObject({
        code: "CONFLICT",
      });
    } finally {
      Reflect.deleteProperty(connector, "legacySignInLifetimeMs");
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
  it("cleans up shared accounts and a hosted link after organization deletion", async () => {
    const org = `deleting-${suffix}`;
    const ownerId = user("outsider");
    const connectors = new ConnectorRegistry([connector]);
    const jobs = { enqueueIn, enqueue: vi.fn(), cancelIn: vi.fn() };
    const expiresAt = new Date(Date.now() + 60_000);
    const revokeUnreferencedAccounts = vi.fn(async () => {});
    connector.revokeUnreferencedAccounts = revokeUnreferencedAccounts;
    const cancelAuthorizationRequest = vi.fn<
      NonNullable<ManagedConnectorProvider["cancelAuthorizationRequest"]>
    >(async () => {});
    connector.cancelAuthorizationRequest = cancelAuthorizationRequest;
    enqueueIn.mockClear();
    try {
      await runAsSystem("delete an organization with shared connection fixtures", async () => {
        await prisma.organization.create({
          data: { id: org, name: "Deleting", slug: org, createdAt: new Date() },
        });
        await prisma.space.create({
          data: { id: org, organizationId: org, name: "Deleting", isDefault: true },
        });
        await prisma.member.create({
          data: {
            id: org,
            organizationId: org,
            userId: ownerId,
            role: "owner",
            createdAt: new Date(),
          },
        });
        for (const [provider, providerRef, status, metadata] of [
          ["exact", "active-account", "connected", {}],
          ["exact", "pending-request", "pending", {}],
          [
            "hosted",
            "hosted",
            "revoked",
            { expiresAt: expiresAt.toISOString(), priorAccountIds: [] },
          ],
        ] as const) {
          await prisma.connection.create({
            data: {
              organizationId: org,
              connectorId: "fixture",
              provider,
              providerRef,
              status,
              displayName: providerRef,
              metadata: { ...metadata },
            },
          });
        }
        await deleteOrganization(
          { prisma, connectors, jobs } as unknown as Parameters<typeof deleteOrganization>[0],
          ownerId,
          org,
        );
        expect(await prisma.connection.count({ where: { organizationId: org } })).toBe(0);
        expect(cancelAuthorizationRequest.mock.calls.map(([ref]) => ref).sort()).toEqual([
          "active-account",
          "pending-request",
        ]);
        expect(revokeUnreferencedAccounts).not.toHaveBeenCalled();
        const job = enqueueIn.mock.calls
          .map(([, job]) => job)
          .find((job) => job.name === "connection.hosted-sign-in-cleanup");
        expect(job.availableAt).toEqual(expiresAt);
        await retryConnectionCleanup({ prisma, connectors, jobs }, job.payload);
        expect(revokeUnreferencedAccounts).toHaveBeenCalledWith(
          "hosted",
          [],
          expect.objectContaining({ organizationId: org }),
        );
      });
    } finally {
      delete connector.cancelAuthorizationRequest;
      delete connector.revokeUnreferencedAccounts;
      await runAsSystem("remove the organization deletion fixture", () =>
        prisma.organization.deleteMany({ where: { id: org } }),
      );
    }
  });
});
