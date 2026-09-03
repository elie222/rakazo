// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolActivityDisclosure } from "./ToolActivityDisclosure";

describe("ToolActivityDisclosure", () => {
  it.each([
    [true, "Working…"],
    [false, "Worked for 1m 43s"],
  ])("defaults collapsed with the %s state label", (live, label) => {
    const html = renderToStaticMarkup(
      <ToolActivityDisclosure live={live} label={label}>
        <span>Shell ×2</span>
      </ToolActivityDisclosure>,
    );

    expect(html).toContain("<details");
    expect(html).not.toMatch(/<details[^>]* open/);
    expect(html).toContain(`<summary`);
    expect(html).toContain(label);
    expect(html).toContain("Shell ×2");
  });

  it("collapses again when live work completes", () => {
    const container = document.createElement("div");
    const root = createRoot(container);
    const render = (live: boolean) =>
      flushSync(() =>
        root.render(
          <ToolActivityDisclosure live={live} label={live ? "Working…" : "Worked for 1m 43s"}>
            <span>Shell ×2</span>
          </ToolActivityDisclosure>,
        ),
      );

    render(true);
    container.querySelector("summary")?.click();
    expect(container.querySelector("details")?.open).toBe(true);

    render(false);
    expect(container.querySelector("details")?.open).toBe(false);
    expect(container.querySelector("summary")?.textContent).toContain("Worked for 1m 43s");
    root.unmount();
  });
});
