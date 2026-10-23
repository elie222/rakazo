// @vitest-environment jsdom

import type { ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("@rakazo/chat-ui/web", () => ({
  ChatMarkdown: ({ children }: { children: string }) => <p>{children}</p>,
}));

import { SubagentCard } from "./SubagentCard";

function mountCard(block: Parameters<typeof SubagentCard>[0]["block"]) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() => root.render(<SubagentCard block={block} />));
  const get = (id: string) => container.querySelector(`[data-testid="${id}"]`);
  const toggle = () => container.querySelector<HTMLButtonElement>("button[aria-expanded]");
  const click = () => flushSync(() => toggle()?.click());
  return {
    get,
    toggle,
    click,
    unmount: () => {
      root.unmount();
      container.remove();
    },
  };
}

const finished = {
  kind: "subagent" as const,
  agentId: "agent-1",
  name: "writer",
  task: "A long brief",
  status: "completed" as const,
  result: "A long report",
};

describe("SubagentCard", () => {
  it("starts folded to one line of the task, without the result", () => {
    const card = mountCard({ ...finished, agentId: "agent-folded" });
    expect(card.toggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(card.get("subagent-task")?.textContent).toBe("A long brief");
    expect(card.get("subagent-task")?.className).toContain("truncate");
    expect(card.get("subagent-body")).toBeNull();
    card.unmount();
  });

  it("opens to the full task and result, and folds again", async () => {
    const card = mountCard({ ...finished, agentId: "agent-toggle" });
    card.click();
    expect(card.toggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(card.get("subagent-task")?.className).not.toContain("truncate");
    expect(card.get("subagent-body")?.textContent).toBe("A long report");

    card.click();
    expect(card.toggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(card.get("subagent-task")?.className).toContain("truncate");
    await vi.waitFor(() => expect(card.get("subagent-body")).toBeNull());
    card.unmount();
  });

  it("shows progress when opened while the helper runs", () => {
    const card = mountCard({
      ...finished,
      agentId: "agent-progress",
      status: "running",
      result: undefined,
      progress: "Reading files",
    });
    expect(card.get("subagent-card")?.textContent).toContain("subagent");
    expect(card.get("subagent-body")).toBeNull();
    card.click();
    expect(card.get("subagent-body")?.textContent).toBe("Reading files");
    card.unmount();
  });

  it("has no body before the helper reports anything", () => {
    const card = mountCard({
      ...finished,
      agentId: "agent-silent",
      status: "running",
      result: undefined,
    });
    card.click();
    expect(card.toggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(card.get("subagent-body")).toBeNull();
    card.unmount();
  });

  it("stays open when the saved message replaces the live card", () => {
    const running = mountCard({
      ...finished,
      agentId: "agent-saved",
      status: "running",
      result: undefined,
      progress: "Reading files",
    });
    running.click();
    running.unmount();

    const saved = mountCard({ ...finished, agentId: "agent-saved" });
    expect(saved.toggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(saved.get("subagent-body")?.textContent).toBe("A long report");
    saved.unmount();
  });
});
