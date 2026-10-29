import { afterEach, expect, it, vi } from "vitest";
import { authClient } from "./auth";
import {
  newLogoAvatarActivitySource,
  syncWebLogoAvatarIdentity,
  webLogoAvatarActivity,
} from "./logo-avatar-activity";
import { signOut } from "./sign-out";

vi.mock("@lingui/core/macro", () => ({ t: (parts: TemplateStringsArray) => parts.join("") }));
vi.mock("./auth", () => ({
  authClient: {
    signOut: vi.fn(),
    getSession: vi.fn(),
    $store: { atoms: { session: { get: () => ({ refetch: vi.fn(async () => undefined) }) } } },
  },
}));
afterEach(() => {
  webLogoAvatarActivity.clear();
  vi.clearAllMocks();
});
function reading() {
  syncWebLogoAvatarIdentity("user-a");
  const source = newLogoAvatarActivitySource();
  webLogoAvatarActivity.hydrate(source, {
    threadId: "thread-a",
    cursor: 0,
    botId: "bot-a",
    run: { id: "run-a", botId: "bot-a", status: "running", trigger: "user" },
  });
  const event = {
    id: "event-a",
    spaceId: "space-a",
    threadId: "thread-a",
    seq: 1,
    botId: "bot-a",
    runId: "run-a",
    type: "agent.tool.called" as const,
    payload: { name: "read_file", executionId: "read" },
    createdAt: "2026-10-01T00:00:00Z",
  };
  webLogoAvatarActivity.apply(source, event);
  return { source, event };
}
it("clears live activity only after logout is verified and rejects late feed frames", async () => {
  const { source, event } = reading();
  vi.mocked(authClient.signOut).mockResolvedValue({ error: null } as never);
  vi.mocked(authClient.getSession).mockResolvedValue({ error: null, data: null } as never);
  expect(await signOut()).toBe(true);
  webLogoAvatarActivity.apply(source, { ...event, seq: 2 });
  expect(webLogoAvatarActivity.getActivity("bot-a", "idle")).toBe("idle");
});
it("preserves current activity if the server still reports a signed-in session", async () => {
  reading();
  vi.mocked(authClient.signOut).mockResolvedValue({ error: null } as never);
  vi.mocked(authClient.getSession).mockResolvedValue({
    error: null,
    data: { user: { id: "user-a" } },
  } as never);
  expect(await signOut()).toBe(false);
  expect(webLogoAvatarActivity.getActivity("bot-a")).toBe("reading");
});
