import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router-test-support.js";

describe("deployment HTTP model endpoints setting", () => {
  const actor = {
    userId: "user-1",
    spaceId: "space-1",
    email: "admin@example.test",
    isDeploymentOwner: false,
  } satisfies Actor;

  function fixture({ admin = true, allowed = false } = {}) {
    let allowedNow = allowed;
    const deps = {
      prisma: {
        user: {
          findUnique: vi.fn(async () => ({ email: actor.email, emailVerified: true })),
        },
        deploymentSettings: {
          findUnique: vi.fn(async () => (allowedNow ? { httpModelEndpointsAllowed: true } : null)),
          upsert: vi.fn(async ({ create }: { create: { httpModelEndpointsAllowed: boolean } }) => {
            allowedNow = create.httpModelEndpointsAllowed;
            return {};
          }),
        },
      },
      env: { adminEmails: admin ? [actor.email] : [] },
    } as unknown as RouterDeps;
    const client = createRouterClient(createRouter(deps), {
      context: { actor } as never,
    });
    return { client, deps };
  }

  it("reads and flips the switch as an admin, taking effect without a restart", async () => {
    const { client, deps } = fixture();

    await expect(client.models.httpEndpointsAllowed()).resolves.toEqual({ allowed: false });
    await expect(client.models.setHttpEndpointsAllowed({ allowed: true })).resolves.toEqual({
      allowed: true,
    });
    await expect(client.models.httpEndpointsAllowed()).resolves.toEqual({ allowed: true });
    await expect(client.models.setHttpEndpointsAllowed({ allowed: false })).resolves.toEqual({
      allowed: false,
    });

    expect(deps.prisma.deploymentSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "default" },
        update: { httpModelEndpointsAllowed: true },
      }),
    );
  });

  it("refuses reads and writes for non-admins", async () => {
    const { client } = fixture({ admin: false });

    await expect(client.models.httpEndpointsAllowed()).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(client.models.setHttpEndpointsAllowed({ allowed: true })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
});
