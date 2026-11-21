import { expect, test } from "@playwright/test";
import { pageViewerCode } from "../../../../packages/page-kit/src/compile";
import { buildPageRuntime } from "../../../../packages/page-kit/src/runtime-build";

let runtime = "";
test.beforeAll(async () => {
  runtime = await buildPageRuntime();
});

for (const { lang, dir, text, note } of [
  { lang: "en", dir: "ltr", text: "Task A", note: "Updated this morning" },
  { lang: "he", dir: "rtl", text: "משימה א", note: "עודכן הבוקר" },
]) {
  test(`checklist notes align with task text in ${dir}`, async ({ page }, testInfo) => {
    await page.route("**/*", (route) => route.abort());
    const items = [
      { text, meta: note, done: true },
      { text: "Task B", done: false },
    ];
    const source = `export default function Tasks() {
      return <Page title="Checklist" lang="${lang}"><Checklist items={${JSON.stringify(items)}} /></Page>;
    }`;
    const boot = JSON.stringify({
      code: pageViewerCode(source),
      theme: "light",
      errorTitle: "Error",
      lang,
    });
    await page.setContent(
      `<!doctype html><html><body><div id="root"></div><script>${runtime.replaceAll("</script", "<\\/script")}</script><script>RakazoPage.mount(${boot.replaceAll("<", "\\u003c")});</script></body></html>`,
    );
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
