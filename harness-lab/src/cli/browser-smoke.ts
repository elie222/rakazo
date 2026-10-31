/**
 * Drives the sites in a real browser (the way the harness will) against a running lab:
 *   HARNESS_LAB_DELAY_SCALE=0.05 pnpm start   # in one terminal
 *   pnpm smoke                                # in another
 */
import { chromium } from "@playwright/test";
import { INVEST_USERS, PENSION_USERS } from "../data.js";

const host = process.env.HARNESS_LAB_HOST ?? "127.0.0.1";
const scheme = process.env.HARNESS_LAB_BOT_SCHEME ?? "http";
const base = `${scheme}://${host}`;
const controlBase = `http://${host}`;
const p0 = Number(process.env.HARNESS_LAB_PORT_BASE ?? 7000);
const api = `${controlBase}:${p0}/api`;
const auth = { "x-lab-token": process.env.HARNESS_LAB_TOKEN ?? "" };
const code = async (to: string) =>
  (
    (await (await fetch(`${api}/latest-code?to=${to}`, { headers: auth })).json()) as {
      code: string;
    }
  ).code;
const check = (ok: boolean, what: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${what}`);
  if (!ok) process.exitCode = 1;
};

await fetch(`${api}/reset`, { method: "POST", headers: auth });
const browser = await chromium.launch();
const ctx = await browser.newContext({
  locale: "he-IL",
  acceptDownloads: true,
  ignoreHTTPSErrors: true, // the lab CA is not in the smoke browser's trust store
});

// 1. pension: login inside the cross-origin iframe, annual report PDF
const dana = PENSION_USERS[0]!;
const p = await ctx.newPage();
await p.goto(`${base}:${p0 + 1}/login`);
const frame = p.frameLocator("iframe");
await frame.locator("#id").fill(dana.idNumber);
await frame.locator("#phone").fill(dana.phone);
await frame.locator("input[name=terms]").check();
await frame.getByRole("button", { name: "שליחת קוד" }).click();
await frame.locator("#code").waitFor();
await frame.locator("#code").fill(await code(dana.phone));
await frame.getByRole("button", { name: "אישור" }).click();
await p.waitForURL("**/dashboard");
await p.getByRole("button", { name: "לא תודה" }).click();
check((await p.locator("[data-testid=fund]").count()) === 3, "pension dashboard shows 3 funds");
await p.goto(`${base}:${p0 + 1}/reports`);
const [dl] = await Promise.all([
  p.waitForEvent("download"),
  p.getByRole("link", { name: /2025/ }).first().click(),
]);
check(
  dl.suggestedFilename().includes("2025"),
  `pension report downloaded (${dl.suggestedFilename()})`,
);

// 2. invest: password + 2FA, SPA routing, shadow DOM, slow table, two-level menu
const ronen = INVEST_USERS[0]!;
const t = await ctx.newPage();
await t.goto(`${base}:${p0 + 2}/`);
await t.locator("#u").fill(ronen.username);
await t.locator("#p").fill(ronen.password);
await t.getByRole("button", { name: "המשך" }).click();
await t.getByLabel(/דואר אלקטרוני/).check();
await t.getByRole("button", { name: "שליחת קוד" }).click();
await t.locator("#c").waitFor();
await t.locator("#c").fill(await code(ronen.email));
await t.getByRole("button", { name: "אישור" }).click();
await t.waitForURL("**/app/portfolio");
await t.locator("table[data-testid=holdings]").waitFor();
check((await t.locator("tbody tr").count()) === 6, "invest holdings table lazy-loaded");
check(
  /₪/.test(await t.locator("tv-account-summary #total").innerText()),
  "shadow DOM widget readable",
);
await t.getByRole("button", { name: /דוחות ▾/ }).click();
await t.getByRole("button", { name: /דוחות תקופתיים/ }).click();
await t.getByRole("button", { name: "רבעוני" }).click();
await t.locator("table[data-testid=quarterly]").waitFor();
check(t.url().endsWith("/app/reports/quarterly"), "two-level menu reaches quarterly report");

// 3. flights: autocomplete, date picker, results
const f = await ctx.newPage();
await f.goto(`${base}:${p0 + 3}/`);
await f.locator("#from-t").fill("tel");
await f.getByRole("option", { name: /TLV/ }).click();
await f.locator("#to-t").fill("athe");
await f.getByRole("option", { name: /ATH/ }).click();
await f.locator("#date-t").click();
await f.locator("#next").click();
await f.locator("button[data-d='2026-12-14']").click();
await f.getByRole("button", { name: "חיפוש טיסות" }).click();
await f.waitForURL("**/results**");
check((await f.locator("[data-testid=offer]").count()) === 12, "flight results listed");
await f.selectOption("#sort", "price");
const first = Number(
  await f.locator("[data-testid=offer]:visible").first().getAttribute("data-price"),
);
check(
  first ===
    Math.min(
      ...(await f
        .locator("[data-testid=offer]")
        .evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-price"))))),
    ),
  "sorting by price puts the cheapest first",
);

await browser.close();
