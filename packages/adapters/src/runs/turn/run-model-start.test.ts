import { expect, it, vi } from "vitest";
import type { ExecutorDeps } from "../executor/executor-deps.js";
import { runModelBackups, startRunModel } from "./run-model-start.js";

it("starts on the authorized organization key without hosted model access", async () => {
  const load = vi.fn(async () => "fixture-organization-key");
  const deps = {
    prisma: {
      organizationModelConnection: {
        findFirst: async () => ({ secretId: "fixture", ciphertext: "sealed" }),
      },
      spaceMember: {
        findUnique: async () => ({
          member: { role: "member", organization: { modelCredits: null, billing: null } },
        }),
      },
    },
    secretStore: { load },
    billingEnabled: true,
  } as unknown as ExecutorDeps;
  const run = { id: "run", userId: "user", spaceId: "space", modelPinned: false };
  const backups = runModelBackups(deps, run, {}, false, vi.fn(), true);
  const result = await startRunModel(
    deps,
    run,
    {
      provider: "openai",
      id: "fixture-model",
      credential: null,
      thinkingLevel: null,
      connectionId: "organization:shared",
    },
    undefined,
    backups,
    vi.fn(),
  );
  expect(result.start?.resolved).toMatchObject({
    apiKey: "fixture-organization-key",
    billing: "organization",
  });
  await expect(backups.load()).resolves.toEqual([]);
});
