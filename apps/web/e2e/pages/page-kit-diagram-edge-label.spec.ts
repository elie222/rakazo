import type { APIRequestContext, Locator, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import { PAGE_RUNTIME_PATH } from "@rakazo/core";

const longLabel = "After reviewer approves the first draft";

async function mountPage(page: Page, request: APIRequestContext, code: string) {
  const runtime = await request.get(PAGE_RUNTIME_PATH);
  await expect(runtime).toBeOK();
  await page.setContent('<!doctype html><html lang="en"><div id="root"></div></html>');
  await page.addScriptTag({ content: await runtime.text() });
  await page.addScriptTag({
    content: `window.RakazoPage.mount(${JSON.stringify({ code, theme: "light", errorTitle: "Could not render" })});`,
  });
}

async function expectOutlineInside(svg: Locator) {
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

test("vertical Page diagram edge labels stay inside the scrollable SVG", async ({
  page,
  request,
}) => {
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
  await mountPage(page, request, code);

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
    await expectOutlineInside(svg);
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

test("a one-pixel viewport change cannot start a diagram label measurement loop", async ({
  page,
  request,
}) => {
  await mountPage(
    page,
    request,
    `
      const getBBox = SVGGraphicsElement.prototype.getBBox;
      SVGGraphicsElement.prototype.getBBox = function () {
        const box = getBBox.call(this);
        if (!this.classList.contains("rk-diagram-edge-label")) return box;
        // Cross a rounding boundary when the viewport shifts, as SVG text metrics can.
        const x = this.ownerSVGElement.viewBox.baseVal.x === -95 ? -91.49 : -91.51;
        return new DOMRect(x, box.y, 170, box.height);
      };
      exports.default = function Fixture() {
        return React.createElement(Diagram, {
          nodes: [{ id: "draft", label: "Draft" }, { id: "publish", label: "Publish" }],
          edges: [{ from: "draft", to: "publish", label: ${JSON.stringify(longLabel)} }],
        });
      };
    `,
  );
  const svg = page.getByRole("img", { name: /After reviewer approves the first draft/ });
  await expect(svg).toBeVisible();
  await expectOutlineInside(svg);
});

test("revealing a mounted Page diagram remeasures its edge labels", async ({
  page,
  request,
}, testInfo) => {
  await mountPage(
    page,
    request,
    `
      exports.default = function Fixture() {
        const h = React.createElement;
        return h("main", null,
          h("button", { onClick: () => { document.getElementById("workflow").hidden = false; } }, "Show workflow"),
          h("div", { id: "workflow", hidden: true, style: { width: 320 } },
            h(Diagram, {
              nodes: [{ id: "draft", label: "Draft" }, { id: "publish", label: "Publish" }],
              edges: [{ from: "draft", to: "publish", label: ${JSON.stringify(longLabel)} }],
            })));
      };
    `,
  );
  const workflow = page.locator("#workflow");
  const svg = workflow.locator("svg");
  await expect(svg).toBeAttached();
  await expect(svg).toBeHidden();
  await page.getByRole("button", { name: "Show workflow" }).click();
  await expect(svg).toBeVisible();
  await expectOutlineInside(svg);
  const name = "page-diagram-label-after-reveal";
  const path = testInfo.outputPath(`${name}.png`);
  await workflow.screenshot({ animations: "disabled", path });
  await testInfo.attach(name, { contentType: "image/png", path });
});

test("Page diagrams reflect edits to the same node and edge arrays", async ({ page, request }) => {
  await mountPage(
    page,
    request,
    `
      const nodes = [{ id: "sent", label: "Sent" }, { id: "done", label: "Done" }];
      const edges = [{ from: "sent", to: "done", label: "Next" }];
      exports.default = function Fixture() {
        const [revision, setRevision] = React.useState(0);
        const h = React.createElement;
        return h("main", { "data-revision": revision },
          h("button", { onClick: () => {
            nodes[0].label = "Draft ready";
            edges[0].label = ${JSON.stringify(longLabel)};
            setRevision(revision + 1);
          } }, "Edit workflow"),
          h(Diagram, { nodes, edges }));
      };
    `,
  );
  const svg = page.locator("svg");
  await expect(svg).toHaveAccessibleName(/Sent.*Next/);
  await page.getByRole("button", { name: "Edit workflow" }).click();
  await expect(svg).toHaveAccessibleName(/Draft ready.*After reviewer approves the first draft/);
  await expect(svg.locator(".rk-diagram-label").first()).toHaveText("Draft ready");
  await expectOutlineInside(svg);
});

test("a visible Page diagram remeasures after an installed font changes", async ({
  page,
  request,
}) => {
  await mountPage(
    page,
    request,
    `
      document.documentElement.style.setProperty("--rk-font", '"Times New Roman", serif');
      let renders = 0;
      exports.default = function Fixture() {
        const h = React.createElement;
        return h("div", { id: "workflow", "data-renders": ++renders, style: { width: 320 } },
          h(Diagram, {
            nodes: [{ id: "sent", label: "Sent" }, { id: "done", label: "Done" }],
            edges: [{ from: "sent", to: "done", label: ${JSON.stringify(longLabel)} }],
          }));
      };
    `,
  );
  const diagram = page.locator("#workflow");
  const svg = diagram.locator("svg");
  const label = svg.locator(".rk-diagram-edge-label");
  await expect(svg).toBeVisible();
  await expectOutlineInside(svg);
  const initialViewBox = (await svg.getAttribute("viewBox"))!;
  const initialRenders = (await diagram.getAttribute("data-renders"))!;
  const width = () => label.evaluate((text: SVGTextElement) => text.getBBox().width);
  const initialWidth = await width();

  await page.evaluate(() => {
    const root = document.documentElement;
    root.dataset.fontLoads = "0";
    document.fonts.addEventListener("loadingdone", () => {
      root.dataset.fontLoads = String(Number(root.dataset.fontLoads) + 1);
    });
    root.style.setProperty("--rk-font", '"Courier New", monospace');
  });
  await expect.poll(width).toBeGreaterThan(initialWidth + 5);
  await expectOutlineInside(svg);
  await expect(svg).not.toHaveAttribute("viewBox", initialViewBox);

  await page.evaluate(() =>
    document.documentElement.style.setProperty("--rk-font", '"Times New Roman", serif'),
  );
  await expect(svg).toHaveAttribute("viewBox", initialViewBox);
  await expect(diagram).toHaveAttribute("data-renders", initialRenders);
  await expect(page.locator("html")).toHaveAttribute("data-font-loads", "0");
});

for (const [property, changedStyle] of [
  ["letter spacing", { letterSpacing: "2.5px" }],
  ["font weight", { fontWeight: 700 }],
] as const) {
  test(`a visible Page diagram remeasures after changing inherited ${property}`, async ({
    page,
    request,
  }) => {
    await mountPage(
      page,
      request,
      `
        const h = React.createElement;
        let renders = 0;
        function Workflow() {
          return h("div", { id: "workflow", "data-renders": ++renders },
            h(Diagram, {
              nodes: [{ id: "sent", label: "Sent" }, { id: "done", label: "Done" }],
              edges: [{ from: "sent", to: "done", label: ${JSON.stringify(longLabel)} }],
            }));
        }
        exports.default = function Fixture() {
          const [changed, setChanged] = React.useState(false);
          const diagram = React.useMemo(() => h(Workflow), []);
          return h("main", null,
            h("button", { onClick: () => setChanged(!changed) }, "Toggle typography"),
            h("div", { style: {
              width: 320,
              fontFamily: "Times New Roman, serif",
              letterSpacing: "normal",
              fontWeight: 400,
              ...(changed ? ${JSON.stringify(changedStyle)} : {}),
            } }, diagram));
        };
      `,
    );
    const diagram = page.locator("#workflow");
    const svg = diagram.locator("svg");
    const label = svg.locator(".rk-diagram-edge-label");
    await expect(svg).toBeVisible();
    await expectOutlineInside(svg);
    const initialViewBox = (await svg.getAttribute("viewBox"))!;
    const initialRenders = (await diagram.getAttribute("data-renders"))!;
    const width = () => label.evaluate((text: SVGTextElement) => text.getBBox().width);
    const initialWidth = await width();
    const initialFamily = await label.evaluate((text) => getComputedStyle(text).fontFamily);
    const toggle = page.getByRole("button", { name: "Toggle typography" });

    await toggle.click();
    await expect.poll(width).toBeGreaterThan(initialWidth + 1);
    await expectOutlineInside(svg);
    await expect(svg).not.toHaveAttribute("viewBox", initialViewBox);
    await expect(label).toHaveCSS("font-family", initialFamily);

    await toggle.click();
    await expect(svg).toHaveAttribute("viewBox", initialViewBox);
    await expect(diagram).toHaveAttribute("data-renders", initialRenders);
  });
}
