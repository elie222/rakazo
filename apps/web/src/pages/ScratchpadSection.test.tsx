// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("../lib/rpc", () => ({
  rpc: { scratchpad: { list: vi.fn().mockResolvedValue([]), remove: vi.fn() } },
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { rpc } from "../lib/rpc";
import { ScratchpadSection } from "./ScratchpadSection";

it("hides the entire empty section", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ScratchpadSection botId="bot-fixture" />));
    expect(container.querySelector('[data-testid="bot-scratchpad"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("renders open and parked work without status chrome and removes a wrapped item", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const title =
    "Review the proposed settings and document the remaining decisions before the next design review";
  const item = {
    id: "work-fixture",
    botId: "bot-fixture",
    title,
    notes: "Compare both themes",
    status: "parked" as const,
    createdAt: "",
    updatedAt: "",
  };
  vi.mocked(rpc.scratchpad.list).mockResolvedValueOnce([item]).mockResolvedValueOnce([]);
  vi.mocked(rpc.scratchpad.remove).mockResolvedValue({ ok: true });
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ScratchpadSection botId="bot-fixture" />));
    expect(container.querySelector('[aria-label="New open-work item"]')).toBeNull();
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Add open work"]')!.click(),
    );
    expect(container.querySelector('[aria-label="New open-work item"]')).not.toBeNull();
    expect(container.textContent).toContain(title);
    expect(container.textContent).toContain("Compare both themes");
    expect(container.textContent).not.toContain("parked");
    expect(container.querySelector('[aria-label="Park"]')).toBeNull();
    expect(container.querySelector('[aria-label="Reopen"]')).toBeNull();
    expect(container.querySelector('[aria-label="Complete"]')).not.toBeNull();
    const remove = container.querySelector<HTMLButtonElement>('[aria-label="Remove"]')!;
    expect(remove).not.toBeNull();
    await act(async () => remove.click());
    expect(rpc.scratchpad.remove).toHaveBeenCalledWith({ itemId: item.id });
    expect(container.textContent).not.toContain(title);
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});

it("shows only the first five items until Show more", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.mocked(rpc.scratchpad.list).mockResolvedValueOnce(
    Array.from({ length: 7 }, (_, i) => ({
      id: `item-${i}`,
      botId: "fixture",
      title: `Task ${i}`,
      notes: "",
      status: "open",
      createdAt: "",
      updatedAt: "",
    })),
  );
  const host = document.createElement("div");
  const root = createRoot(host);
  try {
    await act(async () => root.render(<ScratchpadSection botId="fixture" />));
    expect(host.querySelectorAll('[role="checkbox"]')).toHaveLength(5);
    expect(host.textContent).not.toContain("Task 6");
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((node) => node.textContent === "Show more")!
        .click(),
    );
    expect(host.querySelectorAll('[role="checkbox"]')).toHaveLength(7);
    expect(host.textContent).toContain("Task 6");
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
