// @vitest-environment jsdom

import type { ReactNode } from "react";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";

vi.mock("../lib/rpc", () => ({
  rpc: { scratchpad: { list: vi.fn().mockResolvedValue([]) } },
}));
vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({ t: (parts: TemplateStringsArray) => parts.join("") }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));

import { ScratchpadSection } from "./ScratchpadSection";

it("renders an empty section with a heading and add field without empty-state copy", async () => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(<ScratchpadSection botId="bot-fixture" />));
    const section = container.querySelector('[data-testid="bot-scratchpad"]')!;
    expect(section.textContent).not.toContain("None yet");
    const heading = section.querySelector("h3");
    expect(heading?.textContent).toBe("Open work");
    expect(heading?.nextElementSibling?.tagName).toBe("FORM");
    expect(section.querySelector('input[placeholder="Add item"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  }
});
