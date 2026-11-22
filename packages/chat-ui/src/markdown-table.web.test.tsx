// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ChatMarkdown } from "./markdown.web";

const longTable = [
  "| Item | Qty |",
  "| --- | --- |",
  ...Array.from({ length: 11 }, (_, index) => `| row ${index + 1} | ${index + 1} |`),
].join("\n");

describe("web markdown table pager focus", () => {
  it("moves focus to the other pager button when the pressed one disables", async () => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    const pageButton = (label: string) =>
      container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
    await act(async () => {
      root.render(<ChatMarkdown>{longTable}</ChatMarkdown>);
    });

    // Next from page 1 to the last page disables Next, so focus must go to Previous.
    pageButton("Next page").focus();
    await act(async () => {
      pageButton("Next page").click();
    });
    expect(pageButton("Next page").disabled).toBe(true);
    expect(document.activeElement).toBe(pageButton("Previous page"));

    // Previous from the last page to the first disables Previous, so focus must go to Next.
    await act(async () => {
      pageButton("Previous page").click();
    });
    expect(pageButton("Previous page").disabled).toBe(true);
    expect(document.activeElement).toBe(pageButton("Next page"));

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
