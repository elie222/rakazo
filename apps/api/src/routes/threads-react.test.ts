import { createRouterClient } from "@orpc/server";
import type { Actor } from "@rakazo/contracts";
import { beforeEach, expect, it, vi } from "vitest";
import type { RouterDeps } from "../router.js";
import { createRouter } from "../router.js";
import { reactToThreadMessage } from "../thread-reactions.js";

vi.mock("../thread-target.js", async (original) => ({
  ...(await original<typeof import("../thread-target.js")>()),
  resolveThreadTarget: vi.fn(async () => ({ kind: "bot", botId: "bot-1", threadId: "thread-1" })),
}));
vi.mock("../thread-reactions.js", () => ({
  reactToThreadMessage: vi.fn(async () => ({ eventSeq: null, runIds: [] })),
}));
vi.mock("./shared.js", async (original) => ({
  ...(await original<typeof import("./shared.js")>()),
  modelSetup: vi.fn(async () => ({ needsModel: false })),
}));

const actor: Actor = {
  spaceId: "space-test",
  userId: "user-test",
  email: "user@example.test",
  isDeploymentOwner: false,
};
const teaching = vi.fn();

function react() {
  const router = createRouter({
    prisma: {
      $queryRaw: vi.fn().mockResolvedValue([{ bypass: null }]),
      taughtSkill: { findFirst: teaching },
    },
    env: { webOrigin: "http://localhost:5173", defaultProvider: "fake", defaultModel: "fake" },
    dataDir: "/tmp/thread-react-test",
  } as unknown as RouterDeps);
  return createRouterClient(router, { context: { actor } }).threads.react({
    botId: "bot-1",
    messageId: "message-1",
    reaction: "👍",
    clientNonce: "nonce-1",
  });
}

function mayStartTurn() {
  return vi.mocked(reactToThreadMessage).mock.calls[0]?.[3].mayStartTurn;
}

beforeEach(() => {
  teaching.mockReset();
  vi.mocked(reactToThreadMessage).mockClear();
});

it("lets a reaction start a turn when the bot is not being taught", async () => {
  teaching.mockResolvedValue(null);
  await expect(react()).resolves.toEqual({ ok: true, runIds: [] });
  expect(mayStartTurn()).toBe(true);
});

it("saves a reaction without starting a turn while the bot is being taught", async () => {
  teaching.mockResolvedValue({ id: "skill-1", status: "recording" });
  await expect(react()).resolves.toEqual({ ok: true, runIds: [] });
  expect(mayStartTurn()).toBe(false);
});

it("reports a failed teaching lookup instead of treating the bot as being taught", async () => {
  teaching.mockRejectedValue(new Error("database unavailable"));
  await expect(react()).rejects.toThrow("database unavailable");
  expect(reactToThreadMessage).not.toHaveBeenCalled();
});
