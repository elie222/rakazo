// @vitest-environment jsdom

import type { MemoryDream } from "@rakazo/contracts";
import type { ComponentProps, ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DreamsList } from "./bot-memory-tabs";

const dreams = vi.hoisted(() => [] as MemoryDream[]);
const dreamNow = vi.hoisted(() => vi.fn());
vi.mock("@lingui/react/macro", () => {
  const t = (parts: TemplateStringsArray, ...values: unknown[]) =>
    parts.reduce((text, part, index) => `${text}${index > 0 ? values[index - 1] : ""}${part}`, "");
  return { useLingui: () => ({ t }), Trans: ({ children }: { children: ReactNode }) => children };
});
vi.mock("@tanstack/react-query", () => ({ useQuery: () => ({ data: dreams }) }));
vi.mock("../../../lib/query/query", () => ({
  useSpaceQueries: () => ({
    memory: {
      dreams: {
        queryOptions: () => ({ queryKey: ["dreams"], queryFn: async () => [] }),
        queryKey: () => ["dreams"],
      },
    },
  }),
  useSave: () => ({ run: dreamNow, pending: false, error: null }),
}));
vi.mock("@rakazo/ui-web", () => ({
  Button: (props: ComponentProps<"button">) => <button type="button" {...props} />,
}));

const roots: Array<{ unmount: () => void }> = [];
afterEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", false);
  roots.splice(0).forEach((root) => {
    act(() => root.unmount());
  });
  document.body.innerHTML = "";
  dreams.length = 0;
  dreamNow.mockClear();
});

function render(memoryOff = false) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  act(() => {
    root.render(<DreamsList botId="bot-1" memoryOff={memoryOff} />);
  });
  roots.push(root);
  return container;
}

const dream = (overrides: Partial<MemoryDream> = {}): MemoryDream => ({
  id: "dream-1",
  status: "completed",
  reason: "idle",
  summary: "Moved to Lisbon.",
  changedPaths: ["MEMORY.md"],
  added: ["Likes tea."],
  archived: ["Old note."],
  errorKind: null,
  undoneAt: null,
  startedAt: "2026-02-02T23:30:00.000Z",
  finishedAt: "2026-02-02T23:31:00.000Z",
  createdAt: "2026-02-02T23:30:00.000Z",
  ...overrides,
  runId: overrides.runId === undefined ? "run-1" : overrides.runId,
});

describe("DreamsList", () => {
  it("explains an empty list", () => {
    const container = render();
    expect(container.textContent).toContain("No dreams yet.");
    expect(container.textContent).toContain("rewrites its notes from your own words");
  });

  it("says dreams are paused while memory is off", () => {
    const container = render(true);
    expect(container.textContent).toContain("Memory is off, so dreams are paused.");
    expect(container.textContent).not.toContain("No dreams yet.");
  });

  it("lists the summary, status and changed notes", () => {
    dreams.push(
      dream(),
      dream({ id: "dream-2", status: "failed", errorKind: "spending", summary: null }),
    );
    const container = render();
    expect(container.querySelectorAll("li")).toHaveLength(2);
    expect(container.textContent).toContain("Moved to Lisbon.");
    expect(container.textContent).toContain("Done");
    expect(container.textContent).toContain("Stopped at the spending limit");
    expect(container.textContent).toContain("+ Likes tea.");
    expect(container.textContent).toContain("− Old note.");
    // No raw ids reach the screen.
    expect(container.innerHTML).not.toContain("dream-1");
  });

  it("says why a dream ran", () => {
    dreams.push(
      dream({ id: "dream-1", reason: "tidy", summary: null }),
      dream({ id: "dream-2", reason: "review", summary: null }),
      dream({ id: "dream-3", reason: "manual", summary: null }),
      dream({ id: "dream-4", reason: "idle", summary: null }),
    );
    const rows = render().querySelectorAll("li");
    expect(rows[0]?.textContent).toContain("Tidy");
    expect(rows[1]?.textContent).toContain("Review");
    expect(rows[2]?.textContent).toContain("Manual");
    expect(rows[3]?.textContent).not.toContain("Manual");
  });

  it("starts a dream now and says what it costs", async () => {
    const container = render();
    expect(container.textContent).toContain("Dreaming now uses one model call.");
    const button = container.querySelector<HTMLButtonElement>('[data-testid="bot-dream-now"]')!;
    await act(async () => button.click());
    expect(dreamNow).toHaveBeenCalledWith(undefined);
  });

  it("undoes the newest finished dream", async () => {
    dreams.push(dream({ id: "dream-9", reason: "manual" }));
    const container = render();
    const button = [...container.querySelectorAll("button")].find(
      (entry) => entry.textContent === "Undo",
    );
    await act(async () => button?.click());
    expect(dreamNow).toHaveBeenCalledWith({ dreamId: "dream-9" });
  });

  it("offers no undo for a dream an import kept without its run", () => {
    dreams.push(dream({ id: "dream-9", reason: "manual", runId: null }));
    const container = render();
    expect(
      [...container.querySelectorAll("button")].some((entry) => entry.textContent === "Undo"),
    ).toBe(false);
  });
});
