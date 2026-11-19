import type { Actor } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { assertRoutineModel } from "./model-pins.js";

const actor = { userId: "user-fixture", spaceId: "space-fixture" } as Actor;
const savedAllowlist = process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST;

afterEach(() => {
  if (savedAllowlist === undefined) delete process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST;
  else process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST = savedAllowlist;
});

describe("a routine's model pin", () => {
  it("refuses a provider the deployment allowlist leaves out, before reading credentials", async () => {
    process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST = "openrouter";
    const deps = {
      prisma: {
        userModelCredential: { findFirst: vi.fn() },
        secret: { findFirst: vi.fn() },
      },
      secrets: { load: vi.fn() },
    } as unknown as RouterDeps;
    await expect(
      assertRoutineModel(
        deps,
        actor,
        { modelProvider: "anthropic", modelId: "claude-haiku-5-5" },
        {} as never,
      ),
    ).rejects.toThrow("This model provider is not allowed on this server.");
    expect(deps.prisma.userModelCredential.findFirst).not.toHaveBeenCalled();
  });

  it("leaves a routine without its own pin alone", async () => {
    process.env.RAKAZO_MODEL_PROVIDER_ALLOWLIST = "openrouter";
    const deps = {
      prisma: {},
      secrets: {},
    } as unknown as RouterDeps;
    await expect(
      assertRoutineModel(deps, actor, { modelProvider: null, modelId: null }, {} as never),
    ).resolves.toBeUndefined();
  });
});
