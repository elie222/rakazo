import { afterEach, expect, it, vi } from "vitest";

const warn = vi.hoisted(() => vi.fn());
vi.mock("@rakazo/logging", () => ({ getLogger: () => ({ warn }) }));

import { createSpeechSummarizer } from "./speech-summary.js";

afterEach(() => warn.mockReset());

it("keeps the model's key out of a failure it logs", async () => {
  // A placeholder for an instance key that a provider error echoes back.
  const apiKey = "fixture-instance-key-0123456789";
  const summarize = createSpeechSummarizer({
    prisma: {} as never,
    runtime: {
      describe: () => ({ capabilities: { compaction: true } }),
      // biome-ignore lint/correctness/useYield: the provider fails before it streams anything.
      run: async function* () {
        throw new Error(`401 from provider: invalid key ${apiKey}`);
      },
    } as never,
    resolveModel: async () => ({ provider: "openai", id: "fixture-model", apiKey }),
  });
  await expect(
    summarize({ userId: "user-1", spaceId: "space-1" } as never, "bot-1", "A long reply."),
  ).resolves.toBeNull();
  expect(warn).toHaveBeenCalledOnce();
  expect(JSON.stringify(warn.mock.calls)).not.toContain(apiKey);
});
