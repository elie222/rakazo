import { describe, expect, it, vi } from "vitest";
import type { ExecutionProfile, PrismaClient } from "./client.js";
import {
  createExecutionProfile,
  executionProfileSnapshot,
  resolveExecutionProfile,
  resolveRunExecutionProfile,
  snapshotBotExecutionProfile,
} from "./execution-profiles.js";

const scope = { spaceId: "space", userId: "user" };
const profile = {
  id: "profile-1",
  seriesId: "series",
  revision: 1,
  ...scope,
  name: "Coding",
  harness: "claude",
  provider: "anthropic",
  credentialId: "account-a",
  protocol: "anthropic",
  authScheme: "api-key",
  modelRoles: {},
  endpoint: "https://api.anthropic.com",
  modelId: "test-model",
  inputModalities: [],
  runtimeVersion: "0.3.300",
  computerId: null,
  createdAt: new Date(0),
} as ExecutionProfile;
const credential = {
  id: "account-a",
  userId: "user",
  provider: "anthropic",
  secretId: "secret-a",
  label: "First account",
};

function fixture() {
  const db = {
    spaceMember: { findFirst: vi.fn().mockResolvedValue({ id: "membership" }) },
    executionProfile: {
      findFirst: vi.fn().mockResolvedValue(profile),
      create: vi.fn().mockImplementation(async ({ data }) => ({ ...data, id: "profile-new" })),
    },
    userModelCredential: { findFirst: vi.fn().mockResolvedValue(credential) },
    secret: { findFirst: vi.fn().mockResolvedValue({ id: "secret-a" }) },
    computer: { findFirst: vi.fn().mockResolvedValue({ id: "computer" }) },
    bot: {
      findFirst: vi.fn().mockResolvedValue({
        id: "bot",
        executionProfileId: profile.id,
        computerId: "computer",
      }),
    },
    $transaction: vi.fn(),
  };
  db.$transaction.mockImplementation(async (fn) => fn(db));
  return { db, prisma: db as unknown as PrismaClient };
}

function run(snapshot = executionProfileSnapshot(profile, credential.secretId, "computer")) {
  return { ...scope, botId: "bot", executionProfileSnapshot: snapshot };
}

describe("explicit execution profiles", () => {
  it("keeps old unbound bots on Pi without consulting another account", async () => {
    const { db, prisma } = fixture();
    expect(
      await resolveRunExecutionProfile(prisma, { ...run(), executionProfileSnapshot: null }),
    ).toBeNull();
    expect(db.userModelCredential.findFirst).not.toHaveBeenCalled();
    expect(db.executionProfile.findFirst).not.toHaveBeenCalled();
  });

  it("resolves the exact account ID, owner and provider, without provider fallback", async () => {
    const { db, prisma } = fixture();
    expect((await resolveExecutionProfile(prisma, scope, profile.id)).credential.id).toBe(
      "account-a",
    );
    expect(db.userModelCredential.findFirst).toHaveBeenCalledExactlyOnceWith({
      where: { id: "account-a", userId: "user", provider: "anthropic" },
    });
    expect(db.secret.findFirst).toHaveBeenCalledWith({
      where: { id: "secret-a", userId: "user", spaceId: null },
      select: { id: true },
    });
  });

  it("keeps the old revision after the bot is rebound while a run is queued", async () => {
    const { db, prisma } = fixture();
    db.bot.findFirst.mockResolvedValue({
      id: "bot",
      executionProfileId: "profile-2",
      computerId: "new-computer",
    });
    const result = await resolveRunExecutionProfile(prisma, run());
    expect(result?.profile.id).toBe("profile-1");
    expect(result?.snapshot.computerId).toBe("computer");
    expect(db.executionProfile.findFirst).toHaveBeenCalledWith({
      where: { id: "profile-1", ...scope },
    });
  });

  it("pins the bot computer and references without copying credential material", async () => {
    const { prisma } = fixture();
    const snapshot = await snapshotBotExecutionProfile(prisma, { ...scope, botId: "bot" });
    expect(snapshot).toEqual(
      executionProfileSnapshot(profile, "secret-a", "computer", credential.label),
    );
    expect(Object.keys(snapshot!)).not.toContain("ciphertext");
    expect(Object.keys(snapshot!)).not.toContain("apiKey");
  });

  it("rejects revoked credentials instead of selecting a second account", async () => {
    const { db, prisma } = fixture();
    db.userModelCredential.findFirst.mockResolvedValue(null);
    await expect(resolveRunExecutionProfile(prisma, run())).rejects.toThrow("disconnected");
    expect(db.userModelCredential.findFirst).toHaveBeenCalledTimes(1);
  });

  it("rejects a reconnect to new secret material after enqueue", async () => {
    const { db, prisma } = fixture();
    db.userModelCredential.findFirst.mockResolvedValue({ ...credential, secretId: "replacement" });
    await expect(resolveRunExecutionProfile(prisma, run())).rejects.toThrow("account changed");
  });

  it("rejects membership revocation, cross-space profiles and cross-user snapshots", async () => {
    const first = fixture();
    first.db.spaceMember.findFirst.mockResolvedValue(null);
    await expect(resolveExecutionProfile(first.prisma, scope, profile.id)).rejects.toThrow(
      "Resource not found",
    );
    const second = fixture();
    second.db.executionProfile.findFirst.mockResolvedValue(null);
    await expect(
      resolveExecutionProfile(second.prisma, { ...scope, spaceId: "other" }, profile.id),
    ).rejects.toThrow("Resource not found");
    const third = fixture();
    await expect(
      resolveRunExecutionProfile(third.prisma, {
        ...run(),
        executionProfileSnapshot: { ...run().executionProfileSnapshot, userId: "other" },
      }),
    ).rejects.toThrow("Resource not found");
    expect(third.db.userModelCredential.findFirst).not.toHaveBeenCalled();
  });

  it("rejects unavailable computers and modified snapshot configuration", async () => {
    const { db, prisma } = fixture();
    await expect(
      resolveRunExecutionProfile(prisma, {
        ...run(),
        executionProfileSnapshot: { ...run().executionProfileSnapshot, modelId: "changed" },
      }),
    ).rejects.toThrow("does not match");
    db.computer.findFirst.mockResolvedValue(null);
    await expect(resolveRunExecutionProfile(prisma, run())).rejects.toThrow("Resource not found");
  });

  it("pins declared model modalities and rejects adding audio to an existing run", async () => {
    const { db, prisma } = fixture();
    const withImages = { ...profile, inputModalities: ["image"] };
    db.executionProfile.findFirst.mockResolvedValue(withImages);
    const pinned = executionProfileSnapshot(withImages, credential.secretId, "computer");
    expect(pinned.inputModalities).toEqual(["image"]);
    await expect(resolveRunExecutionProfile(prisma, run(pinned))).resolves.toBeTruthy();
    await expect(
      resolveRunExecutionProfile(prisma, run({ ...pinned, inputModalities: ["image", "audio"] })),
    ).rejects.toThrow("does not match");
  });

  it("creates another immutable revision rather than editing an existing profile", async () => {
    const { db, prisma } = fixture();
    const created = await createExecutionProfile(prisma, scope, {
      ...profile,
      harness: "claude",
      authScheme: "api-key",
      modelRoles: {},
      protocol: "anthropic",
      inputModalities: [],
      supersedesId: profile.id,
    });
    expect(created.seriesId).toBe(profile.seriesId);
    expect(created.revision).toBe(2);
    expect(db.executionProfile.create).toHaveBeenCalledTimes(1);
    expect(db.$transaction).toHaveBeenCalledWith(expect.any(Function), {
      isolationLevel: "Serializable",
    });
  });
});

it("pins auth header style and model role mapping independently of property order", async () => {
  const { prisma, db } = fixture();
  const configured = {
    ...profile,
    authScheme: "bearer",
    modelRoles: { haiku: "glm-5.3[1m]", opus: "namespace/model" },
  };
  db.executionProfile.findFirst.mockResolvedValue(configured);
  const snapshot = executionProfileSnapshot(configured, credential.secretId, "computer");
  await expect(
    resolveRunExecutionProfile(
      prisma,
      run({ ...snapshot, modelRoles: { opus: "namespace/model", haiku: "glm-5.3[1m]" } }),
    ),
  ).resolves.toBeTruthy();
  await expect(
    resolveRunExecutionProfile(prisma, run({ ...snapshot, authScheme: "api-key" })),
  ).rejects.toThrow("does not match");
  await expect(
    resolveRunExecutionProfile(prisma, run({ ...snapshot, modelRoles: { opus: "other-model" } })),
  ).rejects.toThrow("does not match");
});
