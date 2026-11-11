import { describe, expect, it, vi } from "vitest";
import { routineRunReplyText } from "./routine-runs";

vi.mock("expo-router", () => ({ useFocusEffect: vi.fn() }));
vi.mock("./query", () => ({ queryClient: {}, rpcQuery: {} }));

const steps = (label: string, count = 1) => ({
  kind: "steps" as const,
  steps: [{ label, count }],
});

describe("a silent run's reply on mobile", () => {
  it("keeps the run's order, steps before or between what it wrote", () => {
    expect(
      routineRunReplyText([
        steps("Read the board", 2),
        { kind: "text", text: "Moved **three** tickets." },
      ] as never),
    ).toBe("✓ Read the board ×2\n\nMoved three tickets.");
    expect(
      routineRunReplyText([
        { kind: "text", text: "Starting." },
        steps("Archived done tickets"),
        { kind: "text", text: "Done." },
      ] as never),
    ).toBe("Starting.\n\n✓ Archived done tickets\n\nDone.");
  });

  it("names the files, pages and charts it made", () => {
    expect(
      routineRunReplyText([
        { kind: "file", artifactId: "a", name: "board.csv", mimeType: "text/csv", size: 1 },
        { kind: "page", pageId: "p", version: 1, title: "Weekly board" },
        { kind: "text", text: "Done." },
      ] as never),
    ).toBe("board.csv\n\nWeekly board\n\nDone.");
  });

  it("names a helper with what it found", () => {
    expect(
      routineRunReplyText([
        {
          kind: "subagent",
          agentId: "h1",
          name: "Researcher",
          task: "Find the prices",
          status: "completed",
          result: "Found **3** prices.",
        },
        { kind: "text", text: "Done." },
      ] as never),
    ).toBe("Researcher: Found 3 prices.\n\nDone.");
  });

  it("is empty for a run that kept no reply", () => {
    expect(routineRunReplyText(undefined)).toBe("");
    expect(routineRunReplyText([])).toBe("");
  });
});
