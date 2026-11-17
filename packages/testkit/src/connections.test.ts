import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { connectionCleanupJob, connectionCleanupJobKey } from "@rakazo/adapter-kit";
import type { InMemoryJobQueue } from "@rakazo/adapters";
import {
  ComposioConnector,
  EncryptedSecretStore,
  FakeComposioClient,
  InstalledConnectorProvider,
  lockProviderConnectionScope,
  PipedreamConnector,
  ThirdPartyConnectorEmulator,
} from "@rakazo/adapters";
import type { createApp } from "@rakazo/api/app";
import { deferred } from "@rakazo/core/test-async";
import { appliedModelRole, runAsSystem, runAsTenant, updateModelRole } from "@rakazo/db";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sessionCookieHeader } from "./index.js";
import { asSystem } from "./system-db.js";

type App = { request: (input: string, init?: RequestInit) => Response | Promise<Response> };
type AppHandles = Awaited<ReturnType<typeof createApp>>;
type Actor = { spaceId: string; userId: string };

process.env.WAKEUP_DRIVER = "memory";
process.env.SANDBOX_PROVIDER = "fake";
process.env.AGENT_RUNTIME = "scripted";

const hasDb = process.env.VERIFY_DATABASE === "1" && Boolean(process.env.DATABASE_URL);
const describeWithDatabase = hasDb ? describe : describe.skip;
const TEST_ENCRYPTION_KEY = "offline-connector-test-encryption-key";

describeWithDatabase("Composio catalog reconciliation", () => {
  let handles: AppHandles;
  let app: App;
  let fake: FakeComposioClient;
  let composio: ComposioConnector;
  let pipedream: PipedreamConnector;
  let thirdParties: ThirdPartyConnectorEmulator;
  let connectionOrdinal = 0;
  const stamp = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const dataDir = mkdtempSync(path.join(tmpdir(), "rakazo-connections-"));

  beforeAll(async () => {
    const { createApp } = await import("@rakazo/api/app");
    fake = new FakeComposioClient();
    composio = new ComposioConnector({ client: fake });
    thirdParties = new ThirdPartyConnectorEmulator();
    pipedream = new PipedreamConnector(
      {
        clientId: "fake-client-id",
        clientSecret: "fake-client-secret",
        projectId: "fake-project-id",
        environment: "development",
        identitySecret: TEST_ENCRYPTION_KEY,
      },
      { fetch: thirdParties.fetch, resolveHostname: thirdParties.resolveHostname },
    );
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      composio,
      pipedream,
      remoteConnectors: {
        fetch: thirdParties.fetch,
        resolveHostname: thirdParties.resolveHostname,
      },
      encryptionKey: TEST_ENCRYPTION_KEY,
      signupsEnabled: "true",
    });
    app = handles.app;
  });

  afterAll(async () => {
    await handles?.stop();
    rmSync(dataDir, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serializes overlapping backup replacements without mixing users or orders", async () => {
    const ownerCookie = await signup(app, `backup-owner-${stamp}@rakazo.test`, "Owner");
    const otherCookie = await signup(app, `backup-other-${stamp}@rakazo.test`, "Other");
    const owner = await rpc<Actor>(app, ownerCookie, "me");
    const other = await rpc<Actor>(app, otherCookie, "me");
    const first = [{ provider: "provider-a", modelId: "first" }];
    const second = [
      { provider: "provider-b", modelId: "second" },
      { provider: "provider-c", modelId: "third" },
    ];
    const replace = (actor: Actor, backups: typeof first) =>
      runAsTenant(actor, () => updateModelRole(handles.prisma, actor, "main", { backups }));
    const backups = async (actor: Actor) =>
      (await runAsTenant(actor, () => appliedModelRole(handles.prisma, actor, "main"))).backups;
    await replace(other, first);
    await Promise.all([replace(owner, first), replace(owner, second)]);
    expect([first, second]).toContainEqual(await backups(owner));
    expect(await backups(other)).toEqual(first);
  });

  it("reconciles one scoped row per provider under concurrent catalog fetches", async () => {
    const ownerCookie = await signup(app, `owner-connections-${stamp}@rakazo.test`, "Owner");
    const otherCookie = await signup(app, `other-connections-${stamp}@rakazo.test`, "Other");
    const owner = await rpc<Actor>(app, ownerCookie, "me");
    const other = await rpc<Actor>(app, otherCookie, "me");
    await connectRemote(composio, owner, "GMAIL");

    const first = await createConnection(owner, "GMAIL");
    const duplicate = await createConnection(owner, "GMAIL");
    const otherProvider = await createConnection(owner, "SLACK");
    const otherUser = await createConnection(
      { spaceId: owner.spaceId, userId: other.userId },
      "GMAIL",
    );
    const otherWorkspace = await createConnection(
      { spaceId: other.spaceId, userId: owner.userId },
      "GMAIL",
    );

    const catalogs = await Promise.all(
      Array.from({ length: 4 }, () =>
        rpc<Array<{ slug: string; connected: boolean }>>(app, ownerCookie, "connections/catalog"),
      ),
    );
    for (const catalog of catalogs) {
      expect(catalog).toContainEqual(expect.objectContaining({ slug: "GMAIL", connected: true }));
    }

    await expect(statuses([first.id, duplicate.id])).resolves.toEqual([
      { id: first.id, status: "connected" },
      { id: duplicate.id, status: "revoked" },
    ]);
    await expect(statuses([otherProvider.id, otherUser.id, otherWorkspace.id])).resolves.toEqual([
      { id: otherProvider.id, status: "pending" },
      { id: otherUser.id, status: "pending" },
      { id: otherWorkspace.id, status: "pending" },
    ]);

    await rpc(app, ownerCookie, "connections/catalog");
    await expect(statuses([first.id, duplicate.id])).resolves.toEqual([
      { id: first.id, status: "connected" },
      { id: duplicate.id, status: "revoked" },
    ]);
  });

  it("keeps a second connected account for the same provider and renames it", async () => {
    const cookie = await signup(app, `multi-account-${stamp}@rakazo.test`, "Multi Account");
    const first = await rpc<{ connectionId: string }>(app, cookie, "connections/begin", {
      connectorId: "composio",
      provider: "GMAIL",
      displayName: "Personal",
    });
    const second = await rpc<{ connectionId: string }>(app, cookie, "connections/begin", {
      connectorId: "composio",
      provider: "GMAIL",
      displayName: "Work",
    });
    await expect(
      rpc<Array<{ id: string; displayName: string; status: string }>>(
        app,
        cookie,
        "connections/list",
      ),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: first.connectionId,
          displayName: "Personal",
          status: "connected",
        }),
        expect.objectContaining({
          id: second.connectionId,
          displayName: "Work",
          status: "connected",
        }),
      ]),
    );

    await expect(
      rpc<{ displayName: string }>(app, cookie, "connections/rename", {
        connectionId: second.connectionId,
        displayName: "Work inbox",
      }),
    ).resolves.toMatchObject({ displayName: "Work inbox" });

    await rpc(app, cookie, "connections/catalog");
    await expect(statuses([first.connectionId, second.connectionId])).resolves.toEqual([
      { id: first.connectionId, status: "connected" },
      { id: second.connectionId, status: "connected" },
    ]);

    await rpc(app, cookie, "connections/revoke", { connectionId: first.connectionId });
    await expect(
      rpc<Array<{ id: string; status: string }>>(app, cookie, "connections/list"),
    ).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.connectionId, status: "revoked" }),
        expect.objectContaining({ id: second.connectionId, status: "connected" }),
      ]),
    );

    // Uninstall the remaining account: catalog must flip off Added.
    await rpc(app, cookie, "connections/revoke", { connectionId: second.connectionId });
    await expect(
      rpc<Array<{ slug: string; connected: boolean }>>(app, cookie, "connections/catalog", {
        connectorId: "composio",
      }),
    ).resolves.toContainEqual(expect.objectContaining({ slug: "GMAIL", connected: false }));
  });

  it("removes the authorization of a begin that lost its row once the provider answers again", async () => {
    const cookie = await signup(app, `lost-begin-${stamp}@rakazo.test`, "Lost Begin");
    const actor = await rpc<Actor>(app, cookie, "me");
    const begin = composio.begin.bind(composio);
    vi.spyOn(composio, "begin").mockImplementation(async (request, context) => {
      const started = await begin(request, context);
      // The connection is removed while the provider is still answering.
      await asSystem(handles.prisma).connection.updateMany({
        where: { spaceId: actor.spaceId, userId: actor.userId, provider: "GMAIL" },
        data: { status: "revoked" },
      });
      return started;
    });
    const cancel = composio.cancelAuthorizationRequest.bind(composio);
    const cancelled = vi
      .spyOn(composio, "cancelAuthorizationRequest")
      .mockImplementation(cancel)
      .mockRejectedValueOnce(new Error("provider unavailable"));

    await expect(
      rpc(app, cookie, "connections/begin", {
        connectorId: "composio",
        provider: "GMAIL",
        displayName: "Gmail",
      }),
    ).rejects.toThrow();

    // The failed removal went to its backup job, which the queue ran.
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    await vi.waitFor(
      async () => expect(await composio.listConnectedAccountIds(actor.userId, "GMAIL")).toEqual([]),
      { timeout: 10_000 },
    );
  });

  /** The queued cleanup for `cleanup`, while the test's in-memory queue still holds one. */
  const queuedCleanup = (cleanup: Parameters<typeof connectionCleanupJobKey>[0]) =>
    (handles.jobs as unknown as InMemoryJobQueue).keyedJob(connectionCleanupJobKey(cleanup));
  const cleanupFailures = () =>
    handles.backgroundFailures?.().find((failure) => failure.name === "connection.cleanup")
      ?.count ?? 0;
  /** Runs the queued cleanup as the queue does once it is due. */
  async function runCleanupNow(cleanup: Parameters<typeof connectionCleanupJob>[0]) {
    await handles.jobs.enqueue(connectionCleanupJob(cleanup));
    await handles.awaitIdle?.();
  }

  it("removes the authorization when saving a begin's result fails, once the provider answers again", async () => {
    const cookie = await signup(app, `unsaved-begin-${stamp}@rakazo.test`, "Unsaved Begin");
    const actor = await rpc<Actor>(app, cookie, "me");
    const begin = composio.begin.bind(composio);
    vi.spyOn(composio, "begin").mockImplementation(async (request, context) => {
      const started = await begin(request, context);
      await asSystem(handles.prisma).connection.updateMany({
        where: { spaceId: actor.spaceId, userId: actor.userId, provider: "GMAIL" },
        data: { status: "revoked" },
      });
      return started;
    });
    // Recording the lost race fails, which fails the transaction that was to save the result.
    vi.spyOn(handles.jobs, "enqueueIn").mockRejectedValueOnce(new Error("queue unavailable"));
    const cancel = composio.cancelAuthorizationRequest.bind(composio);
    const cancelled = vi
      .spyOn(composio, "cancelAuthorizationRequest")
      .mockImplementation(cancel)
      .mockRejectedValueOnce(new Error("provider unavailable"));

    await expect(
      rpc(app, cookie, "connections/begin", {
        connectorId: "composio",
        provider: "GMAIL",
        displayName: "Gmail",
      }),
    ).rejects.toThrow();

    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    await vi.waitFor(
      async () => expect(await composio.listConnectedAccountIds(actor.userId, "GMAIL")).toEqual([]),
      { timeout: 10_000 },
    );
  });

  it("leaves a busy scope alone, removes the authorization once it is free, and can run again", async () => {
    const cookie = await signup(app, `busy-cleanup-${stamp}@rakazo.test`, "Busy Cleanup");
    const actor = await rpc<Actor>(app, cookie, "me");
    await connectRemote(composio, actor, "GMAIL");
    const [ref] = await composio.listConnectedAccountIds(actor.userId, "GMAIL");
    const cleanup = {
      spaceId: actor.spaceId,
      userId: actor.userId,
      connectorId: "composio",
      provider: "GMAIL",
      ref: ref!,
    };
    const cancelled = vi.spyOn(composio, "cancelAuthorizationRequest");
    const failures = cleanupFailures();

    // Another flow holds this user's scope for the app, as it does across its provider call.
    const locked = deferred();
    const released = deferred();
    const holder = runAsSystem("hold a connection scope", () =>
      handles.prisma.$transaction(
        async (tx) => {
          await lockProviderConnectionScope(tx, actor, "composio", "GMAIL");
          locked.resolve();
          await released.promise;
        },
        { timeout: 30_000 },
      ),
    );
    await locked.promise;
    try {
      await runCleanupNow(cleanup);
      expect(cancelled).not.toHaveBeenCalled();
      // Not a failed try: it waits under its own key for a little later.
      expect(cleanupFailures()).toBe(failures);
      expect(queuedCleanup(cleanup)?.availableAt?.getTime()).toBeGreaterThan(Date.now());
    } finally {
      released.resolve();
      await holder;
    }

    await runCleanupNow(cleanup);
    expect(await composio.listConnectedAccountIds(actor.userId, "GMAIL")).toEqual([]);
    expect(queuedCleanup(cleanup)).toBeUndefined();

    // A removal that already happened is safe to repeat.
    await runCleanupNow(cleanup);
    expect(cancelled).toHaveBeenCalledTimes(2);
    expect(cleanupFailures()).toBe(failures);
  });

  it("keeps the cleanup of a lost begin until a sibling has saved its account", async () => {
    const cookie = await signup(app, `sibling-cleanup-${stamp}@rakazo.test`, "Sibling Cleanup");
    const actor = await rpc<Actor>(app, cookie, "me");
    const cleanup = {
      spaceId: actor.spaceId,
      userId: actor.userId,
      connectorId: "pipedream",
      provider: "linear",
    };
    const swept = vi.spyOn(pipedream, "revokeUnreferencedAccounts");
    const deletions = () =>
      thirdParties.records.filter(
        (record) =>
          record.provider === "pipedream" &&
          record.operation === "revoke" &&
          record.app === "linear",
      ).length;
    const deleted = deletions();
    const start = () =>
      rpc<{ connectionId: string }>(app, cookie, "connections/begin", {
        connectorId: "pipedream",
        provider: "linear",
        displayName: "Linear",
      });

    // A sibling is still connecting: its row names the app, not yet an account.
    const sibling = await start();
    const begin = pipedream.begin.bind(pipedream);
    vi.spyOn(pipedream, "begin").mockImplementationOnce(async (request, context) => {
      const started = await begin(request, context);
      // The second connection is removed while the provider is still answering.
      await asSystem(handles.prisma).connection.updateMany({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          provider: "linear",
          id: { not: sibling.connectionId },
        },
        data: { status: "revoked" },
      });
      return started;
    });
    await expect(start()).rejects.toThrow();

    // Which accounts are in use cannot be told yet, so nothing is deleted and the job stays.
    expect(swept).not.toHaveBeenCalled();
    expect(queuedCleanup(cleanup)).toBeDefined();
    await runCleanupNow(cleanup);
    expect(swept).not.toHaveBeenCalled();

    await expect(
      rpc<{ status: string }>(app, cookie, "connections/complete", {
        connectionId: sibling.connectionId,
      }),
    ).resolves.toMatchObject({ status: "connected" });

    await runCleanupNow(cleanup);
    expect(swept).toHaveBeenCalledWith("linear", ["account-linear"], expect.anything());
    expect(queuedCleanup(cleanup)).toBeUndefined();
    // The sibling's own account is kept.
    expect(deletions()).toBe(deleted);
  });

  /** One connected Gmail account, with what its row and the provider hold for it. */
  async function connectedGmail(label: string) {
    const cookie = await signup(app, `${label}-${stamp}@rakazo.test`, label);
    const actor = await rpc<Actor>(app, cookie, "me");
    const { connectionId } = await rpc<{ connectionId: string }>(app, cookie, "connections/begin", {
      connectorId: "composio",
      provider: "GMAIL",
      displayName: "Gmail",
    });
    const row = await asSystem(handles.prisma).connection.findUniqueOrThrow({
      where: { id: connectionId },
      select: { providerRef: true },
    });
    const cleanup = {
      spaceId: actor.spaceId,
      userId: actor.userId,
      connectorId: "composio",
      provider: "GMAIL",
      ref: row.providerRef!,
    };
    const remote = () => composio.listConnectedAccountIds(actor.userId, "GMAIL");
    const status = async () => (await statuses([connectionId]))[0]?.status;
    return { cookie, actor, connectionId, cleanup, remote, status };
  }

  it("leaves the authorization to its row when a begin's save turns out to have landed", async () => {
    const cookie = await signup(app, `landed-save-${stamp}@rakazo.test`, "Landed Save");
    const actor = await rpc<Actor>(app, cookie, "me");
    const own = { spaceId: actor.spaceId, userId: actor.userId, provider: "GMAIL" };
    const cancelled = vi.spyOn(composio, "cancelAuthorizationRequest");
    const begin = composio.begin.bind(composio);
    let state = "";
    vi.spyOn(composio, "begin").mockImplementation(async (request, context) => {
      const started = await begin(request, context);
      state = started.state;
      await asSystem(handles.prisma).connection.updateMany({
        where: own,
        data: { status: "revoked" },
      });
      return started;
    });
    // Saving reports a failure, yet the row holds the result: a commit whose answer was lost.
    vi.spyOn(handles.jobs, "enqueueIn").mockImplementationOnce(async () => {
      await asSystem(handles.prisma).connection.updateMany({
        where: own,
        data: { status: "connected", providerRef: state },
      });
      throw new Error("connection lost at commit");
    });

    await expect(
      rpc(app, cookie, "connections/begin", {
        connectorId: "composio",
        provider: "GMAIL",
        displayName: "Gmail",
      }),
    ).rejects.toThrow();
    await handles.awaitIdle?.();

    // The removal read the row under the provider lock and found the authorization in use.
    expect(cancelled).not.toHaveBeenCalled();
    expect(await composio.listConnectedAccountIds(actor.userId, "GMAIL")).toEqual([state]);
    const cleanup = { ...own, connectorId: "composio", ref: state };

    // The job reads it the same way. (This queue cannot delete a job inside a transaction.)
    await runCleanupNow(cleanup);
    expect(cancelled).not.toHaveBeenCalled();
    expect(await composio.listConnectedAccountIds(actor.userId, "GMAIL")).toEqual([state]);
    expect(queuedCleanup(cleanup)).toBeUndefined();
  });

  it("never removes an account a lost begin was answered with while another row uses it", async () => {
    const { cookie, actor, connectionId, cleanup, remote, status } =
      await connectedGmail("shared-answer");
    const cancelled = vi.spyOn(composio, "cancelAuthorizationRequest");
    // The provider answers the second begin with the account the first connection uses, and
    // the second connection is removed while it does.
    vi.spyOn(composio, "begin").mockImplementationOnce(async () => {
      await asSystem(handles.prisma).connection.updateMany({
        where: {
          spaceId: actor.spaceId,
          userId: actor.userId,
          provider: "GMAIL",
          id: { not: connectionId },
        },
        data: { status: "revoked" },
      });
      return { authorizationUrl: null, state: cleanup.ref };
    });

    await expect(
      rpc(app, cookie, "connections/begin", {
        connectorId: "composio",
        provider: "GMAIL",
        displayName: "Gmail again",
      }),
    ).rejects.toThrow();
    await handles.awaitIdle?.();

    expect(cancelled).not.toHaveBeenCalled();
    expect(await remote()).toEqual([cleanup.ref]);
    expect(await status()).toBe("connected");

    await runCleanupNow(cleanup);
    expect(cancelled).not.toHaveBeenCalled();
    expect(await remote()).toEqual([cleanup.ref]);
    expect(queuedCleanup(cleanup)).toBeUndefined();
  });

  /**
   * The next begin's save reports a failure after the provider answered. Its row is left
   * `saved`, as by a commit whose answer was lost, or holding nothing, as by a save that never
   * ran. Returns what the provider answered with.
   */
  function failNextBeginSave(
    connector: ComposioConnector | PipedreamConnector,
    own: { spaceId: string; userId: string; provider: string },
    left: "saved" | "unsaved",
  ) {
    const rows = asSystem(handles.prisma).connection;
    const answer = { state: "" };
    let attempt: unknown;
    const begin = connector.begin.bind(connector);
    vi.spyOn(connector, "begin").mockImplementationOnce(async (request, context) => {
      const started = await begin(request, context);
      answer.state = started.state;
      const row = await rows.findFirstOrThrow({ where: { ...own, status: "pending" } });
      attempt = (row.metadata as { attempt?: unknown }).attempt;
      // Taking the row for a moment makes the save record the lost race, which then fails it.
      await rows.updateMany({ where: own, data: { status: "revoked" } });
      // A browser authorization: a saved row stays pending until the user has authorized.
      return { ...started, authorizationUrl: "https://provider.example.test/authorize" };
    });
    vi.spyOn(handles.jobs, "enqueueIn").mockImplementationOnce(async () => {
      await rows.updateMany({
        where: own,
        data:
          left === "saved"
            ? {
                status: "pending",
                providerRef: answer.state,
                metadata: { state: answer.state, attempt: attempt as string },
              }
            : { status: "pending" },
      });
      throw new Error("connection lost at commit");
    });
    return answer;
  }

  it("keeps a saved authorization on its row when the save reports a failure, so a later begin cannot drop it", async () => {
    const cookie = await signup(app, `saved-row-${stamp}@rakazo.test`, "Saved Row");
    const actor = await rpc<Actor>(app, cookie, "me");
    const own = { spaceId: actor.spaceId, userId: actor.userId, provider: "GMAIL" };
    const cancelled = vi.spyOn(composio, "cancelAuthorizationRequest");
    const answer = failNextBeginSave(composio, own, "saved");
    const start = () =>
      rpc<{ connectionId: string }>(app, cookie, "connections/begin", {
        connectorId: "composio",
        provider: "GMAIL",
        displayName: "Gmail",
      });
    const rows = () =>
      asSystem(handles.prisma).connection.findMany({
        where: own,
        select: { id: true, status: true, providerRef: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      });

    await expect(start()).rejects.toThrow();
    await handles.awaitIdle?.();

    // The row is what the save made it, not a failed row a later begin would reuse.
    const [saved] = await rows();
    expect(answer.state).not.toBe("");
    expect(saved).toMatchObject({ status: "pending", providerRef: answer.state });
    expect(cancelled).not.toHaveBeenCalled();
    expect(await composio.listConnectedAccountIds(actor.userId, "GMAIL")).toEqual([answer.state]);

    const next = await start();
    expect(next.connectionId).not.toBe(saved!.id);
    expect(await rows()).toContainEqual(saved);

    // Its job finds the authorization in use too.
    await runCleanupNow({ ...own, connectorId: "composio", ref: answer.state });
    expect(cancelled).not.toHaveBeenCalled();
    expect(await composio.listConnectedAccountIds(actor.userId, "GMAIL")).toContain(answer.state);
  });

  it("removes what a failed begin left under the app's name although its own row is still there", async () => {
    const cookie = await signup(app, `own-row-${stamp}@rakazo.test`, "Own Row");
    const actor = await rpc<Actor>(app, cookie, "me");
    const own = { spaceId: actor.spaceId, userId: actor.userId, provider: "linear" };
    const cleanup = { ...own, connectorId: "pipedream" };
    const swept = vi.spyOn(pipedream, "revokeUnreferencedAccounts");
    const failures = cleanupFailures();
    failNextBeginSave(pipedream, own, "unsaved");

    await expect(
      rpc(app, cookie, "connections/begin", {
        connectorId: "pipedream",
        provider: "linear",
        displayName: "Linear",
      }),
    ).rejects.toThrow();

    // Nothing was saved, so the begin's row is failed with no reference and owns no account:
    // the removal does not wait for it.
    await expect(
      asSystem(handles.prisma).connection.findMany({
        where: own,
        select: { status: true, providerRef: true },
      }),
    ).resolves.toEqual([{ status: "error", providerRef: null }]);
    expect(swept).toHaveBeenCalledTimes(1);
    expect(swept).toHaveBeenCalledWith("linear", [], expect.anything());

    // Neither does its job, which finishes instead of waiting for the row to go.
    await runCleanupNow(cleanup);
    expect(swept).toHaveBeenCalledTimes(2);
    expect(cleanupFailures()).toBe(failures);
    expect(queuedCleanup(cleanup)).toBeUndefined();
  });

  it("keeps the cleanup another begin recorded for the same app when its own removal finishes", async () => {
    const cookie = await signup(app, `shared-key-${stamp}@rakazo.test`, "Shared Key");
    const actor = await rpc<Actor>(app, cookie, "me");
    const cleanup = {
      spaceId: actor.spaceId,
      userId: actor.userId,
      connectorId: "pipedream",
      provider: "linear",
    };
    const begin = pipedream.begin.bind(pipedream);
    vi.spyOn(pipedream, "begin").mockImplementationOnce(async (request, context) => {
      const started = await begin(request, context);
      // The connection is removed while the provider is still answering.
      await asSystem(handles.prisma).connection.updateMany({
        where: { spaceId: actor.spaceId, userId: actor.userId, provider: "linear" },
        data: { status: "revoked" },
      });
      return started;
    });
    const sweep = pipedream.revokeUnreferencedAccounts.bind(pipedream);
    const otherDueAt = new Date(Date.now() + 5 * 60_000);
    const swept = vi
      .spyOn(pipedream, "revokeUnreferencedAccounts")
      .mockImplementationOnce(async (slug, keep, context) => {
        await sweep(slug, keep, context);
        // Another begin records its cleanup after this one listed the accounts. Both name
        // only the app, so they share one job.
        await handles.jobs.enqueue(connectionCleanupJob(cleanup, otherDueAt));
      });

    await expect(
      rpc(app, cookie, "connections/begin", {
        connectorId: "pipedream",
        provider: "linear",
        displayName: "Linear",
      }),
    ).rejects.toThrow();

    expect(swept).toHaveBeenCalledTimes(1);
    // The other begin's record is still there, to run when it is due.
    expect(queuedCleanup(cleanup)?.availableAt).toEqual(otherDueAt);
    await runCleanupNow(cleanup);
    expect(swept).toHaveBeenCalledTimes(2);
    expect(queuedCleanup(cleanup)).toBeUndefined();
  });

  it("finishes a superseded connection's failed removal from its job", async () => {
    const { cookie, connectionId, cleanup, remote } = await connectedGmail("superseded");
    // Revoked with its authorization still at the provider, as after an uncertain removal.
    await asSystem(handles.prisma).connection.update({
      where: { id: connectionId },
      data: { status: "revoked" },
    });
    const cancel = composio.cancelAuthorizationRequest.bind(composio);
    const cancelled = vi
      .spyOn(composio, "cancelAuthorizationRequest")
      .mockImplementation(cancel)
      .mockRejectedValueOnce(new Error("provider unavailable"));

    await expect(
      rpc<{ status: string }>(app, cookie, "connections/complete", { connectionId }),
    ).resolves.toMatchObject({ status: "revoked" });

    // The poll's removal failed; the job it recorded removed the authorization.
    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(2), { timeout: 10_000 });
    await vi.waitFor(async () => expect(await remote()).toEqual([]), { timeout: 10_000 });
    await handles.awaitIdle?.();
    expect(queuedCleanup(cleanup)).toBeUndefined();
  });

  it("keeps a connection whose removal the provider refused, and removes it on the next try", async () => {
    const { cookie, connectionId, cleanup, remote, status } = await connectedGmail("refused");
    const revoke = composio.revoke.bind(composio);
    vi.spyOn(composio, "revoke")
      .mockImplementation(revoke)
      .mockRejectedValueOnce(new Error("403 forbidden"));

    await expect(rpc(app, cookie, "connections/revoke", { connectionId })).rejects.toThrow();
    // Nothing was removed, so the row is as it was: the record of the authorization.
    expect(await status()).toBe("connected");
    expect(await remote()).toEqual([cleanup.ref]);
    expect(queuedCleanup(cleanup)).toBeUndefined();

    await rpc(app, cookie, "connections/revoke", { connectionId });
    expect(await status()).toBe("revoked");
    expect(await remote()).toEqual([]);
  });

  it("leaves an uncertain removal to a job that commits with the revoked connection", async () => {
    const { cookie, connectionId, remote, status } = await connectedGmail("uncertain");
    const cancelled = vi.spyOn(composio, "cancelAuthorizationRequest");
    // The provider call times out after the delete may have been sent.
    vi.spyOn(composio, "revoke").mockRejectedValueOnce(new Error("fetch failed"));

    await expect(rpc(app, cookie, "connections/revoke", { connectionId })).rejects.toThrow();
    expect(await status()).toBe("revoked");

    await vi.waitFor(() => expect(cancelled).toHaveBeenCalledTimes(1), { timeout: 10_000 });
    await vi.waitFor(async () => expect(await remote()).toEqual([]), { timeout: 10_000 });
  });

  it("removes a shared account only with the last connection that refers to it", async () => {
    const { cookie, actor, connectionId, cleanup, remote, status } =
      await connectedGmail("shared-account");
    const sibling = await asSystem(handles.prisma).connection.create({
      data: {
        spaceId: actor.spaceId,
        userId: actor.userId,
        connectorId: "composio",
        provider: "GMAIL",
        displayName: "Same account",
        status: "connected",
        providerRef: cleanup.ref,
      },
    });
    const revoked = vi.spyOn(composio, "revoke");

    await rpc(app, cookie, "connections/revoke", { connectionId });
    expect(await status()).toBe("revoked");
    expect(revoked).not.toHaveBeenCalled();
    expect(await remote()).toEqual([cleanup.ref]);

    await rpc(app, cookie, "connections/revoke", { connectionId: sibling.id });
    expect(await remote()).toEqual([]);
  });

  it("marks a connected account Composio reports dead as needing reconnect", async () => {
    const cookie = await signup(app, `reconnect-${stamp}@rakazo.test`, "Reconnect");
    const work = await rpc<{ connectionId: string }>(app, cookie, "connections/begin", {
      connectorId: "composio",
      provider: "GMAIL",
      displayName: "Work",
    });
    const personal = await rpc<{ connectionId: string }>(app, cookie, "connections/begin", {
      connectorId: "composio",
      provider: "GMAIL",
      displayName: "Personal",
    });
    const row = await asSystem(handles.prisma).connection.findUniqueOrThrow({
      where: { id: work.connectionId },
    });
    fake.setStatus(row.providerRef!, "EXPIRED");

    await rpc(app, cookie, "connections/catalog", { connectorId: "composio" });

    await expect(statuses([work.connectionId, personal.connectionId])).resolves.toEqual([
      { id: work.connectionId, status: "error" },
      { id: personal.connectionId, status: "connected" },
    ]);
  });

  it("returns the remote catalog when local reconciliation fails", async () => {
    const cookie = await signup(app, `db-failure-connections-${stamp}@rakazo.test`, "DB Failure");
    const actor = await rpc<Actor>(app, cookie, "me");
    await connectRemote(composio, actor, "SLACK");
    const pending = await createConnection(actor, "SLACK");
    // Keep the rejection sticky: catalog reconciliation may call findMany more
    // than once, and a one-shot mock lets a later call mark the row connected.
    const failure = vi
      .spyOn(asSystem(handles.prisma).connection, "findMany")
      .mockRejectedValue(new Error("simulated reconciliation failure"));

    // Scope to composio so a parallel managed provider cannot consume the one-shot findMany reject.
    const catalog = await rpc<Array<{ slug: string; connected: boolean }>>(
      app,
      cookie,
      "connections/catalog",
      { connectorId: "composio" },
    );

    expect(catalog).toContainEqual(expect.objectContaining({ slug: "SLACK", connected: true }));
    failure.mockRestore();
    await expect(statuses([pending.id])).resolves.toEqual([{ id: pending.id, status: "pending" }]);
  });

  it("does not mutate local state when the provider catalog fails", async () => {
    const cookie = await signup(
      app,
      `provider-failure-connections-${stamp}@rakazo.test`,
      "Provider Failure",
    );
    const actor = await rpc<Actor>(app, cookie, "me");
    const pending = await createConnection(actor, "GITHUB");
    const failure = vi
      .spyOn(composio, "catalog")
      .mockRejectedValueOnce(new Error("simulated provider failure"));

    await expect(
      rpc(app, cookie, "connections/catalog", { connectorId: "composio" }),
    ).resolves.toEqual([]);
    await expect(statuses([pending.id])).resolves.toEqual([{ id: pending.id, status: "pending" }]);
    failure.mockRestore();
  });

  it("routes an emulated Composio app tool with user-scoped connection context", async () => {
    const cookie = await signup(app, `composio-tool-${stamp}@rakazo.test`, "Composio Tool");
    const actor = await rpc<Actor>(app, cookie, "me");
    const started = await rpc<{ connectionId: string; authorizationUrl: null }>(
      app,
      cookie,
      "connections/begin",
      { connectorId: "composio", provider: "GMAIL", displayName: "Gmail" },
    );
    expect(started.authorizationUrl).toBeNull();
    const context = {
      operationId: "composio-product-test",
      traceId: "composio-product-test",
      spaceId: actor.spaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
      connectedConnections: [
        {
          id: started.connectionId,
          connectorId: "composio",
          externalId: "GMAIL",
          displayName: "Gmail",
        },
      ],
    };
    const tools = (await handles.connectors.discoverTools(context)).filter(
      (candidate) => candidate.route?.connectorId === "composio",
    );
    expect(tools.map((tool) => tool.name)).toEqual([
      "GMAIL_FETCH_EMAILS",
      "GMAIL_FETCH_MESSAGE_BY_MESSAGE_ID",
      "GMAIL_FETCH_MESSAGE_BY_THREAD_ID",
      "GMAIL_SEND_EMAIL",
      "GMAIL_CREATE_EMAIL_DRAFT",
      "GMAIL_LIST_LABELS",
    ]);
    const fetchTool = tools.find((tool) => tool.name === "GMAIL_FETCH_EMAILS");
    expect(fetchTool).toBeDefined();
    const events = [];
    for await (const event of handles.connectors.execute(
      {
        tool: fetchTool!.name,
        args: { query: "from:teammate", max_results: 5 },
        executionId: "composio-product-execution",
        route: fetchTool!.route,
      },
      context,
    )) {
      events.push(event);
    }
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "result",
        data: expect.objectContaining({
          data: {
            messages: [
              expect.objectContaining({
                messageId: "18c5f5d1a2b3c4d6",
                subject: "Quarterly planning notes",
              }),
            ],
            resultSizeEstimate: 1,
          },
        }),
      }),
    );
    expect(fake.executions).toContainEqual(
      expect.objectContaining({
        userId: actor.userId,
        tool: "GMAIL_FETCH_EMAILS",
        args: { query: "from:teammate", max_results: 5 },
      }),
    );
  });

  it("runs Pipedream connection and MCP tool execution through the product registry", async () => {
    const cookie = await signup(app, `pipedream-${stamp}@rakazo.test`, "Pipedream Connector");
    const actor = await rpc<Actor>(app, cookie, "me");
    const catalog = await rpc<Array<{ connectorId: string; slug: string; connected: boolean }>>(
      app,
      cookie,
      "connections/catalog",
      { connectorId: "pipedream" },
    );
    expect(catalog).toContainEqual(
      expect.objectContaining({ connectorId: "pipedream", slug: "linear", connected: false }),
    );

    const started = await rpc<{ connectionId: string; authorizationUrl: string }>(
      app,
      cookie,
      "connections/begin",
      { connectorId: "pipedream", provider: "linear", displayName: "Linear" },
    );
    expect(started.authorizationUrl).toBe("https://pipedream.example.test/connect?app=linear");
    await expect(
      rpc<{ status: string }>(app, cookie, "connections/complete", {
        connectionId: started.connectionId,
      }),
    ).resolves.toMatchObject({ status: "connected" });
    const stored = await asSystem(handles.prisma).connection.findUniqueOrThrow({
      where: { id: started.connectionId },
    });
    expect(stored.providerRef).toBe("account-linear");

    const context = {
      operationId: "pipedream-product-test",
      traceId: "pipedream-product-test",
      spaceId: actor.spaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
      connectedConnections: [
        {
          id: started.connectionId,
          connectorId: "pipedream",
          externalId: "linear",
          displayName: "Linear",
          providerRef: stored.providerRef ?? undefined,
        },
      ],
    };
    const tool = (await handles.connectors.discoverTools(context)).find(
      (candidate) => candidate.route?.connectorId === "pipedream",
    );
    expect(tool).toMatchObject({
      name: expect.stringMatching(/^notes.write__/),
      route: {
        connectionId: started.connectionId,
        resourceRevision: stored.providerRef,
        toolName: "notes.write",
      },
    });
    const events = [];
    for await (const event of handles.connectors.execute(
      {
        tool: tool!.name,
        args: { text: "product-pipedream-ok" },
        executionId: "pipedream-product-execution",
        route: tool!.route,
      },
      context,
    )) {
      events.push(event);
    }
    expect(events).toContainEqual(expect.objectContaining({ type: "result" }));

    await rpc(app, cookie, "connections/revoke", { connectionId: started.connectionId });
    await expect(
      rpc<Array<{ id: string; status: string }>>(app, cookie, "connections/list"),
    ).resolves.toContainEqual(
      expect.objectContaining({ id: started.connectionId, status: "revoked" }),
    );
  });

  it("installs Treg, Executor, and custom MCP sources and routes their calls", async () => {
    const cookie = await signup(app, `mcp-connectors-${stamp}@rakazo.test`, "MCP Connectors");
    const actor = await rpc<Actor>(app, cookie, "me");
    const tregCredential = "fake-treg-credential-value";
    const treg = await rpc<{ id: string; secretConfigured: boolean }>(
      app,
      cookie,
      "capabilities/install",
      {
        kind: "mcp",
        name: "Treg",
        source: "https://treg.to/mcp/",
        credential: tregCredential,
        config: { preset: "treg", auth: { type: "bearer" } },
      },
    );
    const custom = await rpc<{ id: string; secretConfigured: boolean }>(
      app,
      cookie,
      "capabilities/install",
      {
        kind: "mcp",
        name: "Custom MCP",
        source: "https://mcp.example.test/mcp",
        config: { preset: "custom", auth: { type: "none" } },
      },
    );
    const executorCredential = "fake-executor-credential-value";
    const executor = await rpc<{ id: string; secretConfigured: boolean }>(
      app,
      cookie,
      "capabilities/install",
      {
        kind: "mcp",
        name: "Executor",
        source: "https://executor.example.test/mcp",
        credential: executorCredential,
        config: { preset: "custom", auth: { type: "bearer" } },
      },
    );
    expect(treg.secretConfigured).toBe(true);
    expect(custom.secretConfigured).toBe(false);
    expect(executor.secretConfigured).toBe(true);
    expect(JSON.stringify(treg)).not.toContain(tregCredential);
    expect(JSON.stringify(executor)).not.toContain(executorCredential);

    const provider = new InstalledConnectorProvider(
      handles.prisma,
      new EncryptedSecretStore(TEST_ENCRYPTION_KEY),
      { fetch: thirdParties.fetch, resolveHostname: thirdParties.resolveHostname },
    );
    const context = {
      operationId: "mcp-product-test",
      traceId: "mcp-product-test",
      spaceId: actor.spaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
    };
    // The executor calls installed connectors from the run.continue job.
    await runAsSystem("background job run.continue", async () => {
      const tools = await provider.discoverTools(context);
      // All three installs expose the same MCP tool name, so approval kinds are disambiguated.
      expect(tools.filter((tool) => tool.route?.toolName === "notes.write")).toHaveLength(3);
      expect(new Set(tools.map((tool) => tool.name)).size).toBe(tools.length);
      for (const install of [treg, executor, custom]) {
        const tool = tools.find((candidate) => candidate.route?.resourceId === install.id);
        expect(tool?.name).toBe(`installed__${install.id}__notes.write`);
        const events = [];
        for await (const event of provider.execute(
          {
            tool: tool!.name,
            args: { text: `mcp-${install.id}` },
            executionId: `mcp-${install.id}`,
            route: tool!.route,
          },
          context,
        )) {
          events.push(event);
        }
        expect(events).toContainEqual(expect.objectContaining({ type: "result" }));
      }
    });
    expect(thirdParties.records).toContainEqual(
      expect.objectContaining({ provider: "mcp", operation: "notes.write", host: "treg.to" }),
    );
    expect(thirdParties.records).toContainEqual(
      expect.objectContaining({
        provider: "mcp",
        operation: "notes.write",
        host: "executor.example.test",
        authenticated: true,
      }),
    );
    expect(JSON.stringify(thirdParties.records)).not.toContain(executorCredential);
    expect(thirdParties.records).toContainEqual(
      expect.objectContaining({
        provider: "mcp",
        operation: "notes.write",
        host: "mcp.example.test",
      }),
    );
  });

  it("imports an OpenAPI connector, keeps its credential encrypted, and routes calls", async () => {
    const cookie = await signup(app, `api-connector-${stamp}@rakazo.test`, "API Connector");
    const actor = await rpc<Actor>(app, cookie, "me");
    const credential = "test-connector-secret-value";
    const install = await rpc<{
      id: string;
      config: Record<string, unknown>;
      secretConfigured: boolean;
    }>(app, cookie, "capabilities/install", {
      kind: "api",
      name: "CRM API",
      source: "https://api.example.test/openapi.json",
      credential,
      config: { openApi: true, auth: { type: "bearer" } },
    });
    expect(install.secretConfigured).toBe(true);
    expect(JSON.stringify(install)).not.toContain(credential);

    const storedInstall = await asSystem(handles.prisma).capabilityInstall.findUniqueOrThrow({
      where: { id: install.id },
    });
    const storedSecret = await asSystem(handles.prisma).secret.findUniqueOrThrow({
      where: { id: storedInstall.secretId! },
    });
    expect(storedSecret.ciphertext).not.toContain(credential);

    const provider = new InstalledConnectorProvider(
      handles.prisma,
      new EncryptedSecretStore(TEST_ENCRYPTION_KEY),
      { fetch: thirdParties.fetch, resolveHostname: thirdParties.resolveHostname },
    );
    const adapterContext = {
      operationId: "api-connector-test",
      traceId: "api-connector-test",
      spaceId: actor.spaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
    };
    const events: unknown[] = [];
    // The executor calls installed connectors from the run.continue job.
    await runAsSystem("background job run.continue", async () => {
      const tools = await provider.discoverTools(adapterContext);
      const tool = tools.find((candidate) => candidate.route?.toolName === "getContact");
      expect(tool).toMatchObject({
        name: "getContact",
        readOnly: true,
      });
      for await (const event of provider.execute(
        {
          tool: tool!.name,
          args: { contactId: "contact-1" },
          executionId: "api-call-1",
          route: tool!.route,
        },
        adapterContext,
      )) {
        events.push(event);
      }
    });
    expect(JSON.stringify(events)).toContain("contact-1");
    expect(JSON.stringify(events)).not.toContain(credential);
    expect(thirdParties.records).toContainEqual(
      expect.objectContaining({
        provider: "openapi",
        path: "/v1/contacts/contact-1",
        authenticated: true,
      }),
    );

    await rpc(app, cookie, "capabilities/remove", { id: install.id });
    await expect(
      asSystem(handles.prisma).secret.findUnique({ where: { id: storedSecret.id } }),
    ).resolves.toBeNull();
  });

  it("imports a GraphQL connector, introspects operations, and routes calls", async () => {
    const cookie = await signup(app, `graphql-connector-${stamp}@rakazo.test`, "GraphQL Connector");
    const actor = await rpc<Actor>(app, cookie, "me");
    const install = await rpc<{
      id: string;
      config: Record<string, unknown>;
      secretConfigured: boolean;
    }>(app, cookie, "capabilities/install", {
      kind: "graphql",
      name: "Star Wars API",
      source: "https://graphql.example.test/graphql",
      config: { auth: { type: "none" } },
    });
    expect(install.secretConfigured).toBe(false);
    expect(Array.isArray((install.config as { operations?: unknown[] }).operations)).toBe(true);
    expect((install.config as { operations: unknown[] }).operations.length).toBeGreaterThan(0);

    const provider = new InstalledConnectorProvider(
      handles.prisma,
      new EncryptedSecretStore(TEST_ENCRYPTION_KEY),
      { fetch: thirdParties.fetch, resolveHostname: thirdParties.resolveHostname },
    );
    const adapterContext = {
      operationId: "graphql-connector-test",
      traceId: "graphql-connector-test",
      spaceId: actor.spaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
    };
    const tools = await provider.discoverTools(adapterContext);
    const tool = tools.find((candidate) => candidate.route?.toolName === "query_hero");
    expect(tool).toMatchObject({
      name: "hero",
      readOnly: true,
    });

    const events = [];
    for await (const event of provider.execute(
      {
        tool: tool!.name,
        args: { episode: "EMPIRE" },
        executionId: "graphql-call-1",
        route: tool!.route,
      },
      adapterContext,
    )) {
      events.push(event);
    }
    expect(JSON.stringify(events)).toContain("ok");
    expect(thirdParties.records).toContainEqual(
      expect.objectContaining({
        provider: "graphql",
        authenticated: false,
      }),
    );

    await rpc(app, cookie, "capabilities/remove", { id: install.id });
  });

  async function createConnection(owner: Actor, provider: string) {
    return asSystem(handles.prisma).connection.create({
      data: {
        spaceId: owner.spaceId,
        userId: owner.userId,
        connectorId: "composio",
        provider,
        displayName: provider,
        status: "pending",
        createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, connectionOrdinal++)),
      },
    });
  }

  async function statuses(ids: string[]) {
    return asSystem(handles.prisma).connection.findMany({
      where: { id: { in: ids } },
      select: { id: true, status: true },
      orderBy: { createdAt: "asc" },
    });
  }
});

async function connectRemote(composio: ComposioConnector, actor: Actor, provider: string) {
  await composio.begin(
    { provider, redirectUrl: "http://127.0.0.1.invalid/callback" },
    {
      operationId: "connections-test",
      traceId: "connections-test",
      spaceId: actor.spaceId,
      userId: actor.userId,
      signal: new AbortController().signal,
    },
  );
}

async function signup(app: App, email: string, name: string) {
  const response = await app.request("/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ email, password: "password12", name }),
  });
  if (!response.ok) throw new Error(`signup failed ${response.status}: ${await response.text()}`);
  return sessionCookieHeader(response);
}

async function rpc<T>(app: App, cookie: string, procedure: string, body: unknown = {}): Promise<T> {
  const response = await app.request(`/rpc/${procedure}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      cookie,
      origin: "http://127.0.0.1:5173",
    },
    body: JSON.stringify({ json: body }),
  });
  const text = await response.text();
  const parsed = JSON.parse(text) as { json?: T; error?: { message?: string } };
  if (!response.ok || parsed.error) {
    throw new Error(`${procedure} ${response.status}: ${parsed.error?.message ?? text}`);
  }
  return parsed.json as T;
}
