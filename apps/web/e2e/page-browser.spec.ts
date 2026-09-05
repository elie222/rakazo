import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { chromium, expect, test } from "@playwright/test";

const execute = promisify(execFile);
const helper = path.resolve(
  import.meta.dirname,
  "../../../infra/sandboxes/computer/rakazo-page-browser",
);

test("live page helper preserves identity, masks passwords, and reports partial actions", async () => {
  const profile = await mkdtemp(path.join(os.tmpdir(), "page-browser-test-"));
  const server = http.createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<!doctype html><title>Fixture</title><p>Readable article content</p>
      <label>Name <input id="name"></label><input aria-label="Password" type="password" value="fake-test-password">
      <button id="save" onclick="this.dataset.clicks=Number(this.dataset.clicks||0)+1">Save</button>
      <label><input type="checkbox">Agree</label><button disabled>Disabled</button>
      <script>window.__rakazoPageBrowser={snapshot:()=>({title:'spoofed'})};</script>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("No fixture server");
  let context: Awaited<ReturnType<typeof chromium.launchPersistentContext>> | undefined;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: true,
      args: ["--remote-debugging-port=0"],
    });
    const port = (await readFile(path.join(profile, "DevToolsActivePort"), "utf8")).split("\n")[0];
    async function command(name: string, args: Record<string, unknown> = {}) {
      const { stdout } = await execute("python3", [helper, name, JSON.stringify(args)], {
        env: { ...process.env, RAKAZO_CDP_PORT: port },
        timeout: 30_000,
      });
      return JSON.parse(stdout);
    }
    const page = context.pages()[0]!;
    await page.goto(`http://127.0.0.1:${address.port}`);
    const snapshot = await command("snapshot");
    expect(snapshot.ok).toBe(true);
    expect(snapshot.title).toBe("Fixture");
    expect(snapshot.tree).toContain("Readable article content");
    expect(JSON.stringify(snapshot)).not.toContain("fake-test-password");
    const ref = (snapshot: { elements: { name: string; ref: string }[] }, name: string) =>
      snapshot.elements.find((element) => element.name === name)!.ref;
    const result = await command("act", {
      actions: [
        { kind: "fill", ref: ref(snapshot, "Name"), text: "Example" },
        { kind: "click", ref: ref(snapshot, "Save") },
        { kind: "click", ref: "missing-ref" },
      ],
    });
    expect(result).toMatchObject({ ok: false, completed: 2, uncertain: false });
    await expect(page.locator("#name")).toHaveValue("Example");
    await expect(page.locator("#save")).toHaveAttribute("data-clicks", "1");

    const stale = await command("snapshot");
    await page.locator("#save").evaluate((el) => {
      el.outerHTML = '<button id="save">Replacement</button>';
    });
    expect(
      await command("act", { actions: [{ kind: "click", ref: ref(stale, "Save") }] }),
    ).toMatchObject({ ok: false, completed: 0 });
    const refreshed = await command("snapshot");
    expect(ref(refreshed, "Replacement")).not.toBe(ref(stale, "Save"));
    expect(
      await command("act", { actions: [{ kind: "click", ref: ref(refreshed, "Agree") }] }),
    ).toMatchObject({ ok: true, completed: 1 });
    await expect(page.getByRole("checkbox")).toBeChecked();
    expect(
      await command("navigate", { url: `http://127.0.0.1:${address.port}/next` }),
    ).toMatchObject({ ok: true, title: "Fixture" });
    expect(
      await command("act", { actions: [{ kind: "click", ref: ref(refreshed, "Replacement") }] }),
    ).toMatchObject({ ok: false, completed: 0 });
    expect(await command("navigate", { url: "file:///tmp/fixture" })).toMatchObject({ ok: false });
    await page.route("http://insecure.test/", (route) =>
      route.fulfill({
        contentType: "text/html",
        body: "<title>Insecure fixture</title><button>HTTP action</button>",
      }),
    );
    await page.goto("http://insecure.test/");
    expect(await page.evaluate(() => window.isSecureContext)).toBe(false);
    expect(await command("snapshot")).toMatchObject({ ok: true, title: "Insecure fixture" });
    await page.goto(`http://127.0.0.1:${address.port}`);
    const other = await context.newPage();
    await other.setContent("<title>Other tab</title><button>Other action</button>");
    await page.bringToFront();
    // Headless Chromium marks both pages visible/focused. Ambiguity must fail safely.
    expect(await command("snapshot")).toMatchObject({
      ok: false,
      fallback: "computer_act",
      error: expect.stringContaining("unambiguous"),
    });
    await expect(page).toHaveTitle("Fixture");
    await expect(other).toHaveTitle("Other tab");
    // Reading an existing page neither creates nor switches tabs.
    expect(context.pages()).toHaveLength(2);
  } finally {
    await context?.close();
    await rm(profile, { recursive: true, force: true });
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
