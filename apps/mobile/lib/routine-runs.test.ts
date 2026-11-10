import { describe, expect, it, vi } from "vitest";

vi.mock("expo-router", () => ({ useFocusEffect: vi.fn() }));
vi.mock("./query", () => ({ queryClient: {}, rpcQuery: {} }));

const { routineRunReplyText } = await import("./routine-runs");

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

  it("is empty for a run that kept no reply", () => {
    expect(routineRunReplyText(undefined)).toBe("");
    expect(routineRunReplyText([])).toBe("");
  });
});
