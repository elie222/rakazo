import { expect, test } from "@playwright/test";
import { PAGE_RUNTIME_PATH } from "@rakazo/core";

for (const { lang, dir, text, note } of [
  { lang: "en", dir: "ltr", text: "Task A", note: "Updated this morning" },
  { lang: "he", dir: "rtl", text: "משימה א", note: "עודכן הבוקר" },
]) {
  test(`checklist notes align with task text in ${dir}`, async ({ page, request }) => {
    const runtime = await request.get(PAGE_RUNTIME_PATH);
    await expect(runtime).toBeOK();
    await page.route("**/*", (route) => route.abort());
    const items = [{ text, meta: note, done: true }];
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
    await expect(checklist.locator(".rk-check-meta")).toHaveText(note);

    const starts = await checklist.evaluate((list, direction) => {
      const start = (selector: string) => {
        const node = list.querySelector(selector);
        if (!node) throw new Error(`Missing ${selector}`);
        const range = document.createRange();
        range.selectNodeContents(node);
        const box = range.getBoundingClientRect();
        return direction === "rtl" ? box.right : box.left;
      };
      return { item: start(".rk-check-text"), note: start(".rk-check-meta") };
    }, dir);
    expect(Math.abs(starts.item - starts.note)).toBeLessThan(1);
  });
}
