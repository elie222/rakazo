import type { RunActivityRow } from "@rakazo/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { activityPreview } from "./activity";
import { resetI18nForTests } from "./i18n";

vi.mock("./api", () => ({ rpc: vi.fn() }));
afterEach(() => resetI18nForTests());
describe("activity preview", () => {
  it("composes translated activity labels, including empty text and sender fallbacks", () => {
    const run = {
      trigger: "bot_message" as const,
      promptSnippet: "Ready",
      agentMessage: { fromBotName: "Maya", kind: "update" as const },
    };
    const preview = (overrides = {}) =>
      activityPreview({
        runId: "run",
        botId: "bot",
        botName: "Helper",
        groupId: null,
        groupName: null,
        threadId: "thread",
        status: "completed",
        notificationsEnabled: false,
        updatedAt: "2026-01-01T00:00:00Z",
        ...run,
        ...overrides,
      });
    expect(preview()).toBe("Update from Maya: Ready");
    resetI18nForTests("de");
    expect(preview()).toBe("Update von Maya: Ready");
    expect(preview({ promptSnippet: "" })).toBe("Update von Maya");
    expect(preview({ agentMessage: { fromBotName: " ", kind: "request" } })).toBe(
      "Ein anderer Agent fragt: Ready",
    );
    expect(preview({ agentMessage: null, promptSnippet: "" })).toBe(
      "Nachricht von einem anderen Agenten",
    );
  });

  it("preserves composed snippets from older servers without agentMessage", () => {
    const run = { trigger: "bot_message", promptSnippet: "Maya asked: Ready" } as RunActivityRow;
    expect(activityPreview(run)).toBe("Maya asked: Ready");
  });
});
