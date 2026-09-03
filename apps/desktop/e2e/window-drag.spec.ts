import { readFileSync } from "node:fs";
import path from "node:path";
import { _electron as electron, expect, test } from "@playwright/test";

const styles = readFileSync(path.resolve(import.meta.dirname, "../../web/src/styles.css"), "utf8");
const fixture = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Rakazo window drag</title><style>${styles}</style></head>
  <body>
    <main>Desktop fixture ready</main>
    <header class="app-drag" id="conversation-header">
      <span>Chief</span>
      <button class="app-no-drag" id="bot-settings">Bot settings</button>
    </header>
    <output id="result"></output>
    <script>
      document.querySelector('#bot-settings').addEventListener('click', () => {
        document.querySelector('#result').textContent = 'opened';
      });
    </script>
  </body>
</html>`;

test("an active Electron window keeps header dragging selection-free and controls clickable", async () => {
  const app = await electron.launch({
    args: ["."],
    cwd: path.resolve(import.meta.dirname, ".."),
    env: {
      ...process.env,
      RAKAZO_WEB_URL: `data:text/html;charset=utf-8,${encodeURIComponent(fixture)}`,
    },
  });

  try {
    const page = await app.firstWindow();
    const active = await app.evaluate(({ BrowserWindow }) => {
      const window = BrowserWindow.getAllWindows()[0];
      window?.show();
      window?.focus();
      return window?.isFocused();
    });
    expect(active).toBe(true);

    const regions = await page.evaluate(() => {
      const header = document.querySelector("#conversation-header");
      const settings = document.querySelector("#bot-settings");
      if (!(header instanceof HTMLElement) || !(settings instanceof HTMLElement)) {
        throw new Error("missing window chrome fixture");
      }
      const headerStyle = getComputedStyle(header);
      const settingsStyle = getComputedStyle(settings);
      return {
        header: {
          appRegion: headerStyle.getPropertyValue("-webkit-app-region"),
          userSelect: headerStyle.userSelect,
        },
        settings: settingsStyle.getPropertyValue("-webkit-app-region"),
      };
    });

    expect(regions).toEqual({
      header: { appRegion: "drag", userSelect: "none" },
      settings: "no-drag",
    });
    await page.getByRole("button", { name: "Bot settings" }).click();
    await expect(page.locator("#result")).toHaveText("opened");
  } finally {
    await app.close();
  }
});
