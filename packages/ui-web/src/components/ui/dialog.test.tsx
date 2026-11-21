// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { Dialog, DialogContent } from "./dialog.js";

// jsdom does no layout, so these assert the classes that keep a panel inside the viewport.
const widths = { md: 600, lg: 760, xl: 920, "2xl": 1080 } as const;

async function classesOf(size: keyof typeof widths | undefined) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () =>
    root.render(
      <Dialog open>
        <DialogContent size={size}>content</DialogContent>
      </Dialog>,
    ),
  );
  const classes = (document.querySelector('[data-slot="dialog-content"]')?.className ?? "").split(
    " ",
  );
  await act(async () => root.unmount());
  container.remove();
  return classes;
}

for (const [size, width] of Object.entries(widths)) {
  it(`keeps the ${size} dialog inside the viewport at every breakpoint`, async () => {
    const classes = await classesOf(size as keyof typeof widths);
    expect(classes).toContain(`w-[${width}px]`);
    expect(classes).toContain("max-w-[calc(100%-2rem)]");
    expect(classes).toContain(`sm:max-w-[min(${width}px,calc(100%-2rem))]`);
    expect(classes).not.toContain(`sm:max-w-[${width}px]`);
  });
}

it("keeps the default dialog narrow", async () => {
  expect(await classesOf(undefined)).toContain("sm:max-w-sm");
});
