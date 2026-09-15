import { describe, expect, it, vi } from "vitest";
import { actorMayUsePrivateRemoteMcp } from "./mcp-private-endpoint.js";

describe("actorMayUsePrivateRemoteMcp", () => {
  it("is false by default", async () => {
    await expect(actorMayUsePrivateRemoteMcp({} as never, "u1", false)).resolves.toBe(false);
  });

  it("is true when the instance escape is on", async () => {
    await expect(actorMayUsePrivateRemoteMcp({} as never, "u1", true)).resolves.toBe(true);
  });

  it("is true only for the deployment owner when the instance escape is off", async () => {
    const prisma = {
      deploymentSettings: {
        findUnique: vi.fn(async () => ({ ownerUserId: "owner" })),
      },
    };
    await expect(actorMayUsePrivateRemoteMcp(prisma as never, "owner", false)).resolves.toBe(true);
    await expect(actorMayUsePrivateRemoteMcp(prisma as never, "other", false)).resolves.toBe(false);
  });
});
