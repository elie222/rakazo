// @vitest-environment jsdom

import { TAKEOVER_COMPUTER_DONE_STATE } from "@rakazo/core";
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

import { ComputerCard } from "./ComputerCard";

const block = {
  kind: "computer",
  state: TAKEOVER_COMPUTER_DONE_STATE,
  text: "Please **sign in** to [Example](https://example.com)",
} as Parameters<typeof ComputerCard>[0]["block"];

function mountCard() {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  flushSync(() =>
    root.render(
      <ComputerCard
        block={block}
        botId="bot-1"
        onOpen={() => undefined}
        onRelease={async () => undefined}
      />,
    ),
  );
  const toggle = () =>
    container.querySelector<HTMLButtonElement>('[data-testid="computer-card-toggle"]');
  return {
    container,
    toggle,
    click: () => flushSync(() => toggle()?.click()),
    unmount: () => {
      root.unmount();
      container.remove();
    },
  };
}

describe("ComputerCard", () => {
  it("folds a settled request to its plain text, not the markdown source", () => {
    const card = mountCard();
    expect(card.toggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(card.toggle()?.textContent).toContain("Done · Please sign in to Example");
    expect(card.toggle()?.textContent).not.toContain("**");
    expect(card.toggle()?.textContent).not.toContain("https://example.com");
    card.unmount();
  });

  it("opens to the full markdown request", () => {
    const card = mountCard();
    card.click();
    expect(card.toggle()?.getAttribute("aria-expanded")).toBe("true");
    expect(card.container.querySelector("p")?.textContent).toBe(block.text);
    card.unmount();
  });
});
