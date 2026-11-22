import { expect, test } from "@playwright/test";
import { PAGE_RUNTIME_PATH } from "@rakazo/core";

for (const { lang, dir, text, note } of [
  { lang: "en", dir: "ltr", text: "Task A", note: "Updated this morning" },
  { lang: "he", dir: "rtl", text: "משימה א", note: "עודכן הבוקר" },
]) {
  test(`checklist notes align with task text in ${dir}`, async ({ page, request }, testInfo) => {
    const runtime = await request.get(PAGE_RUNTIME_PATH);
    await expect(runtime).toBeOK();
    await page.route("**/*", (route) => route.abort());
    const items = [
      { text, meta: note, done: true },
      { text: "Task B", done: false },
    ];
    const code = `
      exports.default = function Tasks() {
        return React.createElement(Page, { title: "Checklist", lang: ${JSON.stringify(lang)} },
          React.createElement(Checklist, { items: ${JSON.stringify(items)} }));
      };
    `;
    await page.setContent('<!doctype html><html><body><div id="root"></div></body></html>');
    await page.addScriptTag({ content: await runtime.text() });
    await page.addScriptTag({
      content: `window.RakazoPage.mount(${JSON.stringify({ code, theme: "light", errorTitle: "Error", lang })});`,
    });
    await expect(page.locator("main")).toHaveAttribute("dir", dir);
    const checklist = page.locator(".rk-checklist");
    await expect(checklist.locator(".rk-check-text").first()).toHaveText(text);
    await expect(checklist.locator(".rk-check-meta")).toHaveText(note);
    const checkboxes = checklist.getByRole("checkbox");
    await expect(checkboxes.first()).toBeChecked();
    await expect(checkboxes.last()).not.toBeChecked();
    await expect(checkboxes.first()).toBeDisabled();
    await expect(checkboxes.last()).toBeDisabled();

    const measurements = [];
    for (const width of [240, 560]) {
      await page.setViewportSize({ width, height: 440 });
      const starts = await checklist.evaluate((list, direction) => {
        const start = (selector: string) => {
          const range = document.createRange();
          range.selectNodeContents(list.querySelector(selector)!);
          const box = range.getBoundingClientRect();
          return direction === "rtl" ? box.right : box.left;
        };
        return { item: start(".rk-check-text"), note: start(".rk-check-meta") };
      }, dir);
      measurements.push({ width, ...starts });
      expect.soft(Math.abs(starts.item - starts.note), `${dir} at ${width}px`).toBeLessThan(1);
    }
    await testInfo.attach("checklist geometry", {
      body: JSON.stringify(measurements),
      contentType: "application/json",
    });
  });
}
