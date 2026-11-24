// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ChatMarkdown } from "./markdown.web";

async function withMarkdown(
  run: (options: {
    container: HTMLElement;
    render: (text: string, streaming?: boolean) => Promise<void>;
  }) => Promise<void>,
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const container = document.createElement("div");
  const root = createRoot(container);
  try {
    await run({
      container,
      render: (text, streaming) =>
        act(async () => {
          root.render(<ChatMarkdown streaming={streaming}>{text}</ChatMarkdown>);
        }),
    });
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
}

it.each([
  ["Use $x_i^2$ here.", "inline"],
  [String.raw`Use \(x_i^2\) here.`, "inline"],
  [String.raw`$$\frac{1}{2}$$`, "block"],
  ["$$\n\\frac{1}{2}\n$$", "block"],
  [String.raw`\[\frac{1}{2}\]`, "block"],
])("typesets %s as %s math", async (source, display) => {
  await withMarkdown(async ({ container, render }) => {
    await render(source);
    await vi.waitFor(() => {
      expect(container.querySelector("math")?.getAttribute("display") ?? "inline").toBe(display);
      expect(container.querySelector("math")).not.toBeNull();
    });
  });
});

it("preserves ordinary currency between formulas", async () => {
  await withMarkdown(async ({ container, render }) => {
    await render("Prices are $5 and $10. Use $x^2$ here.");
    await vi.waitFor(() => expect(container.querySelectorAll("math")).toHaveLength(1));
    expect(container.textContent).toContain("Prices are $5 and $10.");
  });
});

it("keeps a display equation as source until the closing delimiter arrives", async () => {
  await withMarkdown(async ({ container, render }) => {
    const partial = "Previous paragraph.\n\n$$\n\\frac{1}{2}\n";
    await render(partial, true);
    expect(container.querySelector("math")).toBeNull();
    expect(container.textContent).toContain("$$\n\\frac{1}{2}");
    await render(`${partial}$$`, true);
    await vi.waitFor(() => expect(container.querySelector("math[display=block]")).not.toBeNull());
  });
});

it("leaves delimiters in code spans and fenced code alone", async () => {
  await withMarkdown(async ({ container, render }) => {
    await render("`$x$`\n\n```\n$$\nx^2\n$$\n```");
    expect(container.querySelector("math")).toBeNull();
    expect(container.querySelector("p code")?.textContent).toBe("$x$");
    expect(container.querySelector("pre code")?.textContent).toContain("$$\nx^2\n$$");
  });
});

it("shows the source of unsupported TeX alongside valid equations", async () => {
  await withMarkdown(async ({ container, render }) => {
    await render(String.raw`Try $\unknowncommand{a}$ instead of $x^2$.`);
    await vi.waitFor(() => expect(container.querySelectorAll("math")).toHaveLength(1));
    expect(container.textContent).toContain(String.raw`$\unknowncommand{a}$`);
  });
});
