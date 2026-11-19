import { expect, test } from "@playwright/test";
import { buildPageRuntime } from "../../../../packages/page-kit/src/runtime-build";

test("vertical Page diagram edge labels stay inside the scrollable SVG", async ({ page }) => {
  const longLabel = "After reviewer approves the first draft";
  const wideLabel = "承認の後で初稿を確認して次の工程で担当者にもう一度連絡する";
  const code = `
    exports.default = function Fixture() {
      const [label, setLabel] = React.useState("Next");
      const nodes = [{ id: "sent", label: "Sent" }, { id: "done", label: "Done" }];
      const h = React.createElement;
      const diagram = (id, text, direction, width, dir, loop) => h("div",
        { id, dir, style: { width } },
        h(Diagram, {
          nodes,
          direction,
          edges: loop
            ? [{ from: "sent", to: "done" }, { from: "done", to: "sent", label: text }]
            : [{ from: "sent", to: "done", label: text }],
        }));
      return h("main", null,
        h("button", { onClick: () => setLabel(label === "Next" ? ${JSON.stringify(longLabel)} : "Next") }, "Toggle label"),
        diagram("changing", label, "vertical", 320, "ltr"),
        diagram("unlabeled", undefined, "vertical", 320, "ltr"),
        diagram("loop", ${JSON.stringify(longLabel)}, "vertical", 320, "ltr", true),
        diagram("wide-ltr", ${JSON.stringify(wideLabel)}, "vertical", 120, "ltr"),
        diagram("wide-rtl", ${JSON.stringify(wideLabel)}, "vertical", 120, "rtl"),
        diagram("horizontal-ltr", "Next", "horizontal", 320, "ltr"),
        diagram("horizontal-rtl", "Next", "horizontal", 320, "rtl"));
    };
  `;
  await page.setContent('<!doctype html><html lang="en"><div id="root"></div></html>');
  await page.addScriptTag({ content: await buildPageRuntime() });
  await page.addScriptTag({
    content: `window.RakazoPage.mount(${JSON.stringify({ code, theme: "light", errorTitle: "Could not render" })});`,
  });

  const changing = page.locator("#changing svg");
  await expect(changing).toHaveAttribute("viewBox", "-2 -2 92 138");
  await expect(page.locator("#unlabeled svg")).toHaveAttribute("viewBox", "-2 -2 92 122");
  for (const dir of ["ltr", "rtl"]) {
    const horizontal = page.locator(`#horizontal-${dir} svg`);
    await expect(horizontal).toHaveAttribute("viewBox", "-2 -2 268 43");
    await expect(horizontal.locator(".rk-diagram-edge")).toHaveAttribute(
      "d",
      "M88,19.5C132,19.5 132,19.5 176,19.5",
    );
  }

  await page.getByRole("button", { name: "Toggle label" }).click();
  await expect(changing).toHaveAccessibleName(/After reviewer approves the first draft/);
  for (const svg of [changing, page.locator("#loop svg")]) {
    await expect
      .poll(() =>
        svg.evaluate((element: SVGSVGElement) => {
          const { x, width } = element.viewBox.baseVal;
          const box = element.querySelector<SVGTextElement>(".rk-diagram-edge-label")!.getBBox();
          return Math.min(box.x - x, x + width - box.x - box.width);
        }),
      )
      .toBeGreaterThanOrEqual(2.5); // That includes room for the painted outline.
  }

  for (const dir of ["ltr", "rtl"]) {
    const scroller = page.locator(`#wide-${dir} .rk-diagram`);
    await expect(scroller).toBeVisible();
    const bounds = await scroller.evaluate((container, direction) => {
      const label = container.querySelector(".rk-diagram-edge-label")!;
      const { left, right } = container.getBoundingClientRect();
      container.scrollLeft = direction === "rtl" ? -container.scrollWidth : 0;
      const leftClearance = label.getBoundingClientRect().left - left;
      container.scrollLeft = direction === "rtl" ? 0 : container.scrollWidth;
      return {
        left: leftClearance,
        right: right - label.getBoundingClientRect().right,
        scrolls: container.scrollWidth > container.clientWidth,
      };
    }, dir);
    expect(bounds.scrolls).toBe(true);
    expect(bounds.left).toBeGreaterThan(0);
    expect(bounds.right).toBeGreaterThan(0);
  }

  await page.getByRole("button", { name: "Toggle label" }).click();
  await expect(changing).toHaveAttribute("viewBox", "-2 -2 92 138");
});
