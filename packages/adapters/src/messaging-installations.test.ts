import type { MessagingInstallProvider, SecretStore } from "@rakazo/adapter-kit";
import type { Actor } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { IsolationError } from "@rakazo/db";
import { expect, it, vi } from "vitest";
import { MessagingInstallations } from "./messaging-installations.js";
import { fakeCleanupJobs } from "./secret-cleanup.test-support.js";

const actor: Actor = {
  spaceId: "space-a",
  userId: "user-a",
  email: "fake@example.test",
  isDeploymentOwner: false,
};
/** `remote` is whether the secret store keeps credentials elsewhere, as a hosted one does. */
function fixture(remote = true) {
  let session: {
    id: string;
    provider: string;
    botId: string;
    spaceId: string;
    userId: string;
    expiresAt: Date;
  } | null = null;
  let installation: Record<string, unknown> | null = null;
  const prisma = {
    bot: { findFirst: vi.fn(async () => ({ id: "bot-a", spaceId: "space-a" })) },
    spaceMember: { findFirst: vi.fn(async () => ({ id: "member-a" })) },
    messagingInstallSession: {
      create: vi.fn(async ({ data }) => {
        session = data;
        return data;
      }),
      findUnique: vi.fn(async ({ where }) => (session?.id === where.id ? session : null)),
      deleteMany: vi.fn(async ({ where }) => {
        if (where.id && session?.id === where.id) {
          session = null;
          return { count: 1 };
        }
        return { count: 0 };
      }),
    },
    messagingInstallation: {
      findUnique: vi.fn(async () => installation),
      create: vi.fn(async ({ data }) => {
        installation = data;
        return data;
      }),
      updateMany: vi.fn(async ({ data }) => {
        Object.assign(installation!, data);
        return { count: 1 };
      }),
      findFirst: vi.fn(async ({ where }) =>
        installation?.id === where.id && installation?.userId === where.userId
          ? installation
          : null,
      ),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => {
        installation = null;
        return { count: 1 };
      }),
    },
    messagingIdentity: { deleteMany: vi.fn(async () => ({ count: 1 })) },
    $transaction: vi.fn(async (fn) => {
      const result = await fn(prisma);
      if (lostAfterCommit) throw lostAfterCommit;
      return result;
    }),
  };
  let lostAfterCommit: Error | undefined;
  const provider = {
    provider: "slack",
    authorizeUrl: (state: string) => `https://slack.com/install?state=${state}`,
    exchange: vi.fn(async () => ({
      workspaceId: "T1",
      workspaceName: "Test workspace",
      credential: "fake-token",
    })),
  } as unknown as MessagingInstallProvider;
  const secrets = {
    put: vi.fn(async () => ({ ciphertext: "sealed-token" })),
    load: vi.fn(async () => "fake-token"),
    delete: vi.fn(async () => undefined),
    isRemote: () => remote,
  } as unknown as SecretStore;
  const cleanup = fakeCleanupJobs();
  return {
    cleanup,
    /** The worker's attempt at every queued cleanup. */
    runCleanupJobs: () => cleanup.runQueued({ prisma: prisma as unknown as PrismaClient, secrets }),
    /** The next transaction commits, but the process never gets past it. */
    loseProcessAfterCommit: () => {
      lostAfterCommit = new Error("process lost after commit");
    },
    manager: new MessagingInstallations(
      prisma as unknown as PrismaClient,
      secrets,
      provider,
      cleanup.jobs,
    ),
    prisma,
    provider,
    secrets,
    setSession: (value: typeof session) => {
      session = value;
    },
    getSession: () => session,
    setInstallation: (value: typeof installation) => {
      installation = value;
    },
    getInstallation: () => installation,
  };
}
async function begin(f: ReturnType<typeof fixture>) {
  return new URL(await f.manager.start(actor, "bot-a")).searchParams.get("state")!;
}
it("binds a hashed one-use state to the tenant and stores only the sealed credential", async () => {
  const f = fixture();
  const state = await begin(f);
  expect(f.getSession()).toMatchObject({
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId: "bot-a",
  });
  expect(f.getSession()?.id).not.toBe(state);
  await f.manager.complete(actor, state, "code");
  expect(f.getInstallation()).toMatchObject({
    spaceId: "space-a",
    userId: "user-a",
    botId: "bot-a",
    workspaceId: "T1",
    ciphertext: "sealed-token",
  });
  expect(JSON.stringify(f.getInstallation())).not.toContain("fake-token");
  await expect(f.manager.complete(actor, state, "code")).rejects.toThrow("expired");
  expect(f.provider.exchange).toHaveBeenCalledTimes(1);
});
it("rejects expired and forged state before contacting Slack", async () => {
  const f = fixture();
  const state = await begin(f);
  await expect(f.manager.complete(actor, "forged", "code")).rejects.toThrow("Invalid");
  f.setSession({ ...f.getSession()!, expiresAt: new Date(0) });
  await expect(f.manager.complete(actor, state, "code")).rejects.toThrow("expired");
  expect(f.provider.exchange).not.toHaveBeenCalled();
});
it("does not let another Rakazo space claim an installed Slack workspace", async () => {
  const f = fixture();
  const state = await begin(f);
  f.setInstallation({
    id: "other",
    spaceId: "space-b",
    userId: "user-b",
    botId: "bot-b",
    ciphertext: "other-secret",
  });
  await expect(f.manager.complete(actor, state, "code")).rejects.toThrow("already connected");
  expect(f.secrets.put).not.toHaveBeenCalled();
  expect(f.prisma.messagingInstallation.updateMany).not.toHaveBeenCalled();
});
it("only lets the user who started the install finish it", async () => {
  const f = fixture();
  const state = await begin(f);
  await expect(f.manager.complete({ ...actor, userId: "user-b" }, state, "code")).rejects.toThrow(
    "expired",
  );
  expect(f.provider.exchange).not.toHaveBeenCalled();
  await f.manager.complete(actor, state, "code");
  expect(f.provider.exchange).toHaveBeenCalledTimes(1);
});
it("rechecks membership and bot ownership after authorization", async () => {
  const f = fixture();
  const state = await begin(f);
  f.prisma.spaceMember.findFirst.mockResolvedValueOnce(null as never);
  await expect(f.manager.complete(actor, state, "code")).rejects.toThrow("owner");
  expect(f.provider.exchange).not.toHaveBeenCalled();
});
it("requires an owned, active bot before creating an install URL", async () => {
  const f = fixture();
  f.prisma.bot.findFirst.mockResolvedValueOnce(null as never);
  await expect(f.manager.start(actor, "bot-b")).rejects.toBeInstanceOf(IsolationError);
  expect(f.prisma.messagingInstallSession.create).not.toHaveBeenCalled();
});
it("connects the user's first bot in the current space when no bot is chosen", async () => {
  const f = fixture();
  f.prisma.bot.findFirst.mockResolvedValueOnce({ id: "bot-work", spaceId: "space-work" } as never);
  await f.manager.start({ ...actor, spaceId: "space-work" });
  expect(f.prisma.bot.findFirst).toHaveBeenCalledWith(
    expect.objectContaining({
      where: { spaceId: "space-work", userId: "user-a", archivedAt: null },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
  );
  expect(f.prisma.spaceMember.findFirst).not.toHaveBeenCalled();
  expect(f.getSession()).toMatchObject({ botId: "bot-work", spaceId: "space-work" });
});
it("disconnects only the user's own installation, from any of their spaces", async () => {
  const f = fixture();
  f.setInstallation({
    id: "installation-a",
    provider: "slack",
    spaceId: "space-a",
    userId: "user-a",
    ciphertext: "sealed-token",
  });
  await f.manager.remove({ ...actor, userId: "user-b" }, "installation-a");
  expect(f.prisma.messagingInstallation.deleteMany).not.toHaveBeenCalled();
  await f.manager.remove({ ...actor, spaceId: "space-b" }, "installation-a");
  expect(f.prisma.messagingIdentity.deleteMany).toHaveBeenCalledWith({
    where: {
      spaceId: "space-a",
      provider: "slack",
      dmThreadId: { startsWith: "slack~installation-a:" },
    },
  });
  expect(f.getInstallation()).toBeNull();
  expect(f.secrets.delete).toHaveBeenCalledWith("sealed-token", stored("installation-a"));
});
it("does not load credentials after the installation owner loses membership", async () => {
  const f = fixture();
  f.setInstallation({
    id: "installation-a",
    provider: "slack",
    spaceId: "space-a",
    userId: "user-a",
    botId: "bot-a",
    ciphertext: "sealed",
  });
  f.prisma.spaceMember.findFirst.mockResolvedValueOnce(null as never);
  expect(await f.manager.getById("installation-a")).toBeNull();
  expect(f.secrets.load).not.toHaveBeenCalled();
});

it("removes an old secret reference after a successful reconnect", async () => {
  const f = fixture();
  await f.manager.complete(actor, await begin(f), "code");
  const id = f.getInstallation()!.id as string;
  vi.mocked(f.secrets.put).mockResolvedValueOnce({
    id,
    ref: "replacement",
    ciphertext: "replacement",
  });
  await f.manager.complete(actor, await begin(f), "code");
  expect(f.secrets.delete).toHaveBeenCalledWith("sealed-token", stored(id));
  expect(f.getInstallation()?.ciphertext).toBe("replacement");
});

it("removes an unreferenced secret if persisting an installation fails", async () => {
  const f = fixture();
  const state = await begin(f);
  f.prisma.messagingInstallation.create.mockRejectedValueOnce(new Error("write failed"));
  await expect(f.manager.complete(actor, state, "code")).rejects.toThrow("write failed");
  expect(f.secrets.delete).toHaveBeenCalledWith("sealed-token", stored(expect.any(String)));
  expect(f.cleanup.queued.size).toBe(0);
});

it("does not delete a credential when a write committed before a transport error", async () => {
  const f = fixture();
  const state = await begin(f);
  f.prisma.messagingInstallation.create.mockImplementationOnce(async ({ data }) => {
    f.setInstallation(data);
    throw new Error("response lost");
  });
  await expect(f.manager.complete(actor, state, "code")).rejects.toThrow("response lost");
  expect(f.secrets.delete).not.toHaveBeenCalled();
  expect(f.cleanup.queued.size).toBe(0);
});

it("disconnects installations and deletes their secret references before destroying a bot", async () => {
  const f = fixture();
  f.setInstallation({
    id: "install-a",
    provider: "slack",
    spaceId: actor.spaceId,
    userId: actor.userId,
    botId: "bot-a",
    ciphertext: "remote-reference",
  });
  f.prisma.messagingInstallation.findMany.mockResolvedValueOnce([f.getInstallation()] as never);
  await f.manager.removeForBot({ id: "bot-a", spaceId: actor.spaceId, userId: actor.userId });
  expect(f.prisma.messagingInstallation.findMany).toHaveBeenCalledWith({
    where: { botId: "bot-a", spaceId: actor.spaceId, userId: actor.userId },
  });
  expect(f.secrets.delete).toHaveBeenCalledWith("remote-reference", stored("install-a"));
});

it("keeps a completed reconnect successful when external cleanup needs a retry", async () => {
  const f = fixture();
  await f.manager.complete(actor, await begin(f), "code");
  const id = f.getInstallation()!.id as string;
  vi.mocked(f.secrets.put).mockResolvedValueOnce({ id, ref: "new-ref", ciphertext: "new-ref" });
  vi.mocked(f.secrets.delete).mockRejectedValueOnce(new Error("secret store unavailable"));
  await expect(f.manager.complete(actor, await begin(f), "code")).resolves.toBeUndefined();
  expect(f.getInstallation()?.ciphertext).toBe("new-ref");
  expect(f.cleanup.cleanups()).toEqual([{ ...credential(id, "sealed-token"), due: true }]);
  await f.runCleanupJobs();
  expect(f.secrets.delete).toHaveBeenLastCalledWith("sealed-token", stored(id));
});

it("keeps a completed disconnect successful when external cleanup needs a retry", async () => {
  const f = fixture();
  await f.manager.complete(actor, await begin(f), "code");
  const id = f.getInstallation()!.id as string;
  vi.mocked(f.secrets.delete).mockRejectedValueOnce(new Error("secret store unavailable"));
  await expect(f.manager.remove(actor, id)).resolves.toBeUndefined();
  expect(f.getInstallation()).toBeNull();
  expect(f.cleanup.cleanups()).toEqual([{ ...credential(id, "sealed-token"), due: true }]);
  await f.runCleanupJobs();
  expect(f.secrets.delete).toHaveBeenCalledTimes(2);
});

it("records the cleanup with the disconnect and removes it once the credential is deleted", async () => {
  const f = fixture();
  await f.manager.complete(actor, await begin(f), "code");
  const id = f.getInstallation()!.id as string;
  await f.manager.remove(actor, id);
  expect(f.cleanup.jobs.enqueueIn).toHaveBeenCalledWith(
    f.prisma,
    expect.objectContaining({
      name: "secret.cleanup",
      payload: credential(id, "sealed-token"),
      availableAt: expect.any(Date),
    }),
  );
  expect(f.cleanup.jobs.enqueueIn.mock.invocationCallOrder[0]).toBeLessThan(
    vi.mocked(f.secrets.delete).mock.invocationCallOrder[0]!,
  );
  expect(f.cleanup.queued.size).toBe(0);
});

it("deletes a disconnected credential from the job when the process is lost after the commit", async () => {
  const f = fixture();
  await f.manager.complete(actor, await begin(f), "code");
  const id = f.getInstallation()!.id as string;
  f.loseProcessAfterCommit();
  await expect(f.manager.remove(actor, id)).rejects.toThrow("process lost after commit");
  expect(f.getInstallation()).toBeNull();
  expect(f.secrets.delete).not.toHaveBeenCalled();
  expect(f.cleanup.cleanups()).toEqual([{ ...credential(id, "sealed-token"), due: false }]);
  await f.runCleanupJobs();
  expect(f.secrets.delete).toHaveBeenCalledWith("sealed-token", stored(id));
});

it("deletes a replaced credential from the job when the process is lost after the commit", async () => {
  const f = fixture();
  await f.manager.complete(actor, await begin(f), "code");
  const id = f.getInstallation()!.id as string;
  vi.mocked(f.secrets.put).mockResolvedValueOnce({ id, ref: "new-ref", ciphertext: "new-ref" });
  f.loseProcessAfterCommit();
  await expect(f.manager.complete(actor, await begin(f), "code")).rejects.toThrow(
    "process lost after commit",
  );
  // The new credential was saved after all, so only the one it replaced is cleaned up.
  expect(f.getInstallation()?.ciphertext).toBe("new-ref");
  expect(f.secrets.delete).not.toHaveBeenCalled();
  expect(f.cleanup.cleanups()).toEqual([{ ...credential(id, "sealed-token"), due: false }]);
  await f.runCleanupJobs();
  expect(f.secrets.delete).toHaveBeenCalledTimes(1);
  expect(f.secrets.delete).toHaveBeenCalledWith("sealed-token", stored(id));
});

it("never deletes a credential an installation holds again, directly or from the job", async () => {
  const f = fixture();
  await f.manager.complete(actor, await begin(f), "code");
  const installation = { ...f.getInstallation()! };
  const id = installation.id as string;
  // The installation is back, holding the same credential, before the direct attempt reads it.
  f.prisma.messagingInstallation.deleteMany.mockImplementationOnce(async () => ({ count: 1 }));
  await f.manager.remove(actor, id);
  expect(f.secrets.delete).not.toHaveBeenCalled();
  expect(f.cleanup.queued.size).toBe(0);

  f.loseProcessAfterCommit();
  f.prisma.messagingInstallation.deleteMany.mockImplementationOnce(async () => ({ count: 1 }));
  await expect(f.manager.remove(actor, id)).rejects.toThrow("process lost after commit");
  expect(f.cleanup.queued.size).toBe(1);
  await f.runCleanupJobs();
  expect(f.secrets.delete).not.toHaveBeenCalled();
});

it("copies no sealed credential into a job when the store keeps it in the row", async () => {
  const f = fixture(false);
  await f.manager.complete(actor, await begin(f), "code");
  const id = f.getInstallation()!.id as string;
  vi.mocked(f.secrets.put).mockResolvedValueOnce({ id, ref: "new-ref", ciphertext: "new-ref" });
  await f.manager.complete(actor, await begin(f), "code");
  vi.mocked(f.secrets.delete).mockRejectedValueOnce(new Error("notification failed"));
  await expect(f.manager.remove(actor, id)).resolves.toBeUndefined();
  expect(f.secrets.delete).toHaveBeenCalledWith("sealed-token", id);
  expect(f.secrets.delete).toHaveBeenCalledWith("new-ref", id);
  expect(f.cleanup.jobs.enqueue).not.toHaveBeenCalled();
  expect(f.cleanup.jobs.enqueueIn).not.toHaveBeenCalled();
});

function credential(installationId: string, ref: string) {
  return { kind: "messaging_installation", recordId: installationId, ref };
}

/** What a remote store is given to find the entry: the record it was written for. */
function stored(recordId: unknown) {
  return expect.objectContaining({ recordId });
}
