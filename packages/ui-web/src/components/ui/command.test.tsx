// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { Command, CommandInput } from "./command";

it("focuses the command input when its search icon is clicked", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => {
      root.render(
        <Command>
          <CommandInput aria-label="Search" />
        </Command>,
      );
    });
    const input = container.querySelector("input")!;
    input.focus();
    input.blur();
    await act(async () => {
      container.querySelector("svg")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(document.activeElement).toBe(input);
    expect(input.dataset.slot).toBe("input-group-control");
  } finally {
    await act(async () => root.unmount());
    container.remove();
  }
});
