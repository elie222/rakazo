import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { IDENTITY_CONFIRMATION_REQUIRED } from "@rakazo/contracts";
import type { PrismaClient } from "@rakazo/db";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router-test-support.js";
import { MAX_API_KEYS_PER_ACCOUNT } from "./api-key-routes.js";

const actor = {
  spaceId: "space-1",
  userId: "user-1",
  email: "user@rakazo.test",
  isDeploymentOwner: false,
} satisfies Actor;

function setup({ confirmed = true, existing = 0 } = {}) {
  const deleteMany = vi.fn(async ({ where }: { where: { id: string; referenceId: string } }) => ({
    count: where.id === "key-1" && where.referenceId === actor.userId ? 1 : 0,
  }));
  const createApiKey = vi.fn(async (_userId: string, name: string) => ({
    id: "key-2",
    key: "rkz_secret",
    name,
    start: "rkz_se",
    createdAt: new Date("2026-11-25T00:00:00Z"),
  }));
  const deps = {
    prisma: {
      apiKey: {
        findMany: vi.fn(async () => []),
        count: vi.fn(async () => existing),
        deleteMany,
      },
    } as unknown as PrismaClient,
    events: { publishSpaceChange: vi.fn(async () => undefined) },
    auth: {
      createApiKey,
      hasRecentIdentityConfirmation: vi.fn(async () => confirmed),
    },
    env: { defaultProvider: "fake", defaultModel: "fake-model" },
  } as unknown as RouterDeps;
  const client = createRouterClient(createRouter(deps), {
    context: { actor, sessionId: "session-1" } as never,
  });
  return { client, createApiKey, deleteMany };
}

describe("API key procedures", () => {
  it("shows a new key once, for the signed-in person", async () => {
    const { client, createApiKey } = setup();
    await expect(client.apiKeys.create({ name: "laptop" })).resolves.toMatchObject({
      id: "key-2",
      name: "laptop",
      key: "rkz_secret",
      lastUsedAt: null,
    });
    expect(createApiKey).toHaveBeenCalledWith(actor.userId, "laptop");
  });

  it("asks the person to confirm it's them before making a key", async () => {
    const { client, createApiKey } = setup({ confirmed: false });
    await expect(client.apiKeys.create({ name: "laptop" })).rejects.toMatchObject({
      code: IDENTITY_CONFIRMATION_REQUIRED,
    });
    expect(createApiKey).not.toHaveBeenCalled();
  });

  it("stops at the per-account limit", async () => {
    const { client, createApiKey } = setup({ existing: MAX_API_KEYS_PER_ACCOUNT });
    await expect(client.apiKeys.create({ name: "one more" })).rejects.toMatchObject({
      kind: "CONFLICT",
    });
    expect(createApiKey).not.toHaveBeenCalled();
  });

  it("revokes only the caller's own key", async () => {
    const { client, deleteMany } = setup();
    await expect(client.apiKeys.revoke({ id: "key-1" })).resolves.toEqual({ ok: true });
    await expect(client.apiKeys.revoke({ id: "someone-elses" })).rejects.toMatchObject({
      kind: "NOT_FOUND",
    });
    expect(deleteMany).toHaveBeenLastCalledWith({
      where: { id: "someone-elses", referenceId: actor.userId },
    });
  });
});
