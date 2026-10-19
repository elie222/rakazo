import type { AdapterContext, ComputerRef } from "@rakazo/adapter-kit";
import { describe, expect, it, vi } from "vitest";
import {
  browserActFromTool,
  browserNavigateFromTool,
  browserSnapshotFromTool,
  parseBrowserActions,
} from "./browser-tools.js";
import { filterPageBrowserTools, PAGE_BROWSER_TOOL_NAMES } from "./executor.js";
import { FakeBrowserProvider } from "./fake-browser.js";

const context: AdapterContext = {
  operationId: "1",
  traceId: "1",
  spaceId: "w",
  userId: "u",
  signal: new AbortController().signal,
};

const computer: ComputerRef = {
  id: "c1",
  botId: "b1",
  kind: "fake",
  providerRef: "c1",
};

describe("browser tools", () => {
  it("parses click/fill/type actions and rejects bad batches", () => {
    expect(
      parseBrowserActions([
        { kind: "fill", ref: "e1", text: "hi" },
        { kind: "click", ref: "e2" },
      ]),
    ).toEqual([
      { kind: "fill", ref: "e1", text: "hi" },
      { kind: "click", ref: "e2" },
    ]);
    expect(() => parseBrowserActions([])).toThrow(/at least one/i);
    expect(() => parseBrowserActions([{ kind: "click" }])).toThrow(/ref/i);
    expect(() => parseBrowserActions([{ kind: "fill", ref: "e1" }])).toThrow(/text/i);
  });

  it("rejects URL credentials before invoking the browser", async () => {
    const browser = new FakeBrowserProvider();
    browser.navigateError = new Error("must not invoke browser");
    for (const scheme of ["http", "https"]) {
      expect(
        await browserNavigateFromTool(browser, computer, context, {
          url: `${scheme}://example:fake-password@example.test`,
        }),
      ).toMatchObject({ error: expect.stringContaining("credentials") });
    }
  });

  it("navigates, snapshots, and acts through the tool helpers", async () => {
    const browser = new FakeBrowserProvider({
      pages: {
        "https://example.test/x": {
          title: "Demo",
          html: `<!doctype html><html><head><title>Demo</title></head><body>
            <input aria-label="Name" />
            <button>Save</button>
          </body></html>`,
        },
      },
    });
    const navigated = await browserNavigateFromTool(browser, computer, context, {
      url: "https://example.test/x",
    });
    expect(navigated).toMatchObject({ title: "Demo" });
    expect("fallback" in navigated && navigated.fallback).toBeFalsy();

    const snap = await browserSnapshotFromTool(browser, computer, context, {});
    expect(snap).toMatchObject({ title: "Demo" });
    expect(String((snap as { tree?: string }).tree)).toMatch(/\[e\d+\]/);

    const nameRef = (snap as { elements: Array<{ ref: string; name: string }> }).elements.find(
      (el) => el.name.includes("Name"),
    )!.ref;
    const acted = await browserActFromTool(browser, computer, context, {
      actions: [{ kind: "fill", ref: nameRef, text: "Ada" }],
    });
    expect(acted).toMatchObject({ ok: true, completed: 1 });
  });

  it("parses upload steps and bounds their file list", () => {
    expect(
      parseBrowserActions([{ kind: "upload", ref: "e3", paths: [" receipts/march.pdf "] }]),
    ).toEqual([{ kind: "upload", ref: "e3", paths: ["receipts/march.pdf"] }]);
    expect(() => parseBrowserActions([{ kind: "upload", ref: "e3" }])).toThrow(/paths/);
    expect(() => parseBrowserActions([{ kind: "upload", ref: "e3", paths: [""] }])).toThrow(
      /paths/,
    );
    expect(() =>
      parseBrowserActions([{ kind: "upload", ref: "e3", paths: Array(11).fill("a.pdf") }]),
    ).toThrow(/at most 10/);
  });

  it.each([undefined, ["bots/b1", "shared"]])(
    "uses only trusted upload roots: %j",
    async (uploadRoots) => {
      const browser = new FakeBrowserProvider();
      const act = vi.spyOn(browser, "act").mockResolvedValue({
        ok: true,
        completed: 2,
        url: "https://example.test",
        title: "Fixture",
      });
      const actions = [
        { kind: "upload", ref: "e1", paths: ["a.txt"], roots: ["bots/b2"] },
        { kind: "upload", ref: "e2", paths: ["shared/b.txt"], roots: ["."] },
      ];
      expect(parseBrowserActions(actions)).toEqual([
        { kind: "upload", ref: "e1", paths: ["a.txt"] },
        { kind: "upload", ref: "e2", paths: ["shared/b.txt"] },
      ]);
      await browserActFromTool(
        browser,
        computer,
        context,
        { actions },
        {
          uploadRoots,
          resolveUploadPath: (path) => (path.startsWith("shared/") ? path : `bots/b1/${path}`),
        },
      );
      expect(act.mock.calls[0]?.[1].actions).toEqual([
        {
          kind: "upload",
          ref: "e1",
          paths: ["bots/b1/a.txt"],
          ...(uploadRoots ? { roots: uploadRoots } : {}),
        },
        {
          kind: "upload",
          ref: "e2",
          paths: ["shared/b.txt"],
          ...(uploadRoots ? { roots: uploadRoots } : {}),
        },
      ]);
    },
  );

  it("uploads workspace files to a hidden file input by ref", async () => {
    const browser = new FakeBrowserProvider({
      pages: {
        "https://example.test/expense": {
          title: "Expense",
          html: `<!doctype html><html><head><title>Expense</title></head><body>
            <label>Receipt <input type="file" role="button" aria-hidden="true" style="display:none" /></label>
            <button>Save</button>
          </body></html>`,
        },
      },
    });
    await browserNavigateFromTool(browser, computer, context, {
      url: "https://example.test/expense",
    });
    const snap = (await browserSnapshotFromTool(browser, computer, context, {})) as {
      elements: Array<{ ref: string; role: string }>;
    };
    const upload = snap.elements.find((el) => el.role === "file upload");
    expect(upload).toBeDefined();

    const resolved: string[] = [];
    const acted = await browserActFromTool(
      browser,
      computer,
      context,
      { actions: [{ kind: "upload", ref: upload!.ref, paths: ["receipts/march.pdf"] }] },
      {
        resolveUploadPath: (path) => {
          resolved.push(path);
          return `bots/b1/${path}`;
        },
      },
    );
    expect(resolved).toEqual(["receipts/march.pdf"]);
    expect(acted).toMatchObject({ ok: true, completed: 1 });
    expect(String((acted as { tree?: string }).tree)).toContain('value="march.pdf"');

    const freshRef = (acted as { elements: Array<{ ref: string; role: string }> }).elements.find(
      (el) => el.role === "file upload",
    )!.ref;
    const refused = await browserActFromTool(browser, computer, context, {
      actions: [{ kind: "upload", ref: freshRef, paths: ["a.pdf", "b.pdf"] }],
    });
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining("one file") });
  });

  it("parses fill_secret without a value and rejects unknown fields", () => {
    expect(
      parseBrowserActions([
        { kind: "fill_secret", ref: "e1", secret: "site_login", field: "password" },
      ]),
    ).toEqual([{ kind: "fill_secret", ref: "e1", secret: "site_login", field: "password" }]);
    expect(() =>
      parseBrowserActions([{ kind: "fill_secret", ref: "e1", secret: "site_login", field: "pin" }]),
    ).toThrow(/username or password/);
    expect(() =>
      parseBrowserActions([{ kind: "fill_secret", ref: "e1", field: "password" }]),
    ).toThrow(/secret/);
  });

  describe("saved login fills", () => {
    const loginPage = (url: string) =>
      new FakeBrowserProvider({
        pages: {
          [url]: {
            title: "Sign in",
            html: `<!doctype html><html><head><title>Sign in</title></head><body>
              <input aria-label="Email" />
              <input aria-label="Password" type="password" />
            </body></html>`,
          },
        },
      });
    async function refs(browser: FakeBrowserProvider, url: string) {
      await browserNavigateFromTool(browser, computer, context, { url });
      const snap = (await browserSnapshotFromTool(browser, computer, context, {})) as {
        elements: Array<{ ref: string; name: string }>;
      };
      const ref = (name: string) => snap.elements.find((el) => el.name.includes(name))!.ref;
      return { email: ref("Email"), password: ref("Password") };
    }
    const values = { username: "fake-user@example.test", password: "fake-password-1" };
    const resolveSecretFill = async (step: { field: "username" | "password" }) => ({
      text: values[step.field],
      origin: "https://login.example.test",
    });

    it("types saved values on the saved origin and redacts them from the result", async () => {
      const browser = loginPage("https://login.example.test/signin");
      const { email, password } = await refs(browser, "https://login.example.test/signin");
      const acted = await browserActFromTool(
        browser,
        computer,
        context,
        {
          actions: [
            { kind: "fill_secret", ref: email, secret: "site_login", field: "username" },
            { kind: "fill_secret", ref: password, secret: "site_login", field: "password" },
          ],
        },
        { resolveSecretFill, redactions: () => [values.username, values.password] },
      );
      expect(acted).toMatchObject({ ok: true, completed: 2 });
      expect(JSON.stringify(acted)).not.toContain(values.username);
      expect(JSON.stringify(acted)).not.toContain(values.password);
    });

    it("never reports a login-filled field's value, even when too short to redact", async () => {
      const browser = loginPage("https://login.example.test/signin");
      const { email } = await refs(browser, "https://login.example.test/signin");
      const shortName = async () => ({ text: "ada", origin: "https://login.example.test" });
      const acted = await browserActFromTool(
        browser,
        computer,
        context,
        { actions: [{ kind: "fill_secret", ref: email, secret: "site_login", field: "username" }] },
        { resolveSecretFill: shortName },
      );
      expect(acted).toMatchObject({ ok: true });
      expect(JSON.stringify(acted)).not.toContain("ada");
      const snap = await browserSnapshotFromTool(browser, computer, context, {});
      expect(JSON.stringify(snap)).not.toContain("ada");
    });

    it("keeps a login-filled field hidden after ordinary typing appends to it", async () => {
      const browser = loginPage("https://login.example.test/signin");
      const { email } = await refs(browser, "https://login.example.test/signin");
      // Each result carries a fresh snapshot, whose refs replace the previous ones.
      const emailRef = (result: unknown) =>
        (result as { elements: Array<{ ref: string; name: string }> }).elements.find((el) =>
          el.name.includes("Email"),
        )!.ref;
      const filled = await browserActFromTool(
        browser,
        computer,
        context,
        { actions: [{ kind: "fill_secret", ref: email, secret: "site_login", field: "username" }] },
        { resolveSecretFill: async () => ({ text: "ada", origin: "https://login.example.test" }) },
      );
      const typed = await browserActFromTool(browser, computer, context, {
        actions: [{ kind: "type", ref: emailRef(filled), text: "!" }],
      });
      expect(typed).toMatchObject({ ok: true });
      expect(JSON.stringify(typed)).not.toContain("ada");
      const replaced = await browserActFromTool(browser, computer, context, {
        actions: [{ kind: "fill", ref: emailRef(typed), text: "visible-now" }],
      });
      expect(JSON.stringify(replaced)).toContain("visible-now");
    });

    it("refuses to type a saved login into editable page content", async () => {
      const browser = new FakeBrowserProvider({
        pages: {
          "https://login.example.test/notes": {
            title: "Notes",
            html: `<!doctype html><html><head><title>Notes</title></head><body>
              <div contenteditable="true" aria-label="Notes"></div>
            </body></html>`,
          },
        },
      });
      await browserNavigateFromTool(browser, computer, context, {
        url: "https://login.example.test/notes",
      });
      const snap = (await browserSnapshotFromTool(browser, computer, context, {})) as {
        elements: Array<{ ref: string; name: string }>;
      };
      const notes = snap.elements.find((el) => el.name.includes("Notes"))!.ref;
      const acted = await browserActFromTool(
        browser,
        computer,
        context,
        { actions: [{ kind: "fill_secret", ref: notes, secret: "site_login", field: "username" }] },
        { resolveSecretFill },
      );
      expect(acted).toMatchObject({ ok: false, completed: 0 });
      expect(JSON.stringify(acted)).toMatch(/text, email, password, or telephone/);
    });

    it("refuses to type a saved login into a textarea or a non-login input type", async () => {
      const browser = new FakeBrowserProvider({
        pages: {
          "https://login.example.test/signin": {
            title: "Sign in",
            html: `<!doctype html><html><head><title>Sign in</title></head><body>
              <textarea aria-label="Username"></textarea>
              <input aria-label="Query" type="search" />
              <input aria-label="Website" type="url" />
              <input aria-label="Pin" type="number" />
              <input aria-label="Phone" type="tel" />
            </body></html>`,
          },
        },
      });
      await browserNavigateFromTool(browser, computer, context, {
        url: "https://login.example.test/signin",
      });
      const ref = async (name: string) => {
        const snap = (await browserSnapshotFromTool(browser, computer, context, {})) as {
          elements: Array<{ ref: string; name: string }>;
        };
        return snap.elements.find((el) => el.name.includes(name))!.ref;
      };
      for (const name of ["Username", "Query", "Website", "Pin"]) {
        const acted = await browserActFromTool(
          browser,
          computer,
          context,
          {
            actions: [
              {
                kind: "fill_secret",
                ref: await ref(name),
                secret: "site_login",
                field: "username",
              },
            ],
          },
          { resolveSecretFill },
        );
        expect(acted, name).toMatchObject({ ok: false, completed: 0 });
        expect(JSON.stringify(acted), name).toMatch(/text, email, password, or telephone/);
      }
      const phone = await browserActFromTool(
        browser,
        computer,
        context,
        {
          actions: [
            {
              kind: "fill_secret",
              ref: await ref("Phone"),
              secret: "site_login",
              field: "username",
            },
          ],
        },
        { resolveSecretFill },
      );
      expect(phone).toMatchObject({ ok: true, completed: 1 });
    });

    it("refuses to type a saved login on a private-LAN HTTP origin", async () => {
      const origin = "http://192.168.2.10:8080";
      const browser = new FakeBrowserProvider({
        pages: {
          [`${origin}/signin`]: {
            title: "Sign in",
            html: `<!doctype html><html><head><title>Sign in</title></head><body>
              <input aria-label="Email" />
            </body></html>`,
          },
        },
      });
      await browserNavigateFromTool(browser, computer, context, { url: `${origin}/signin` });
      const snap = (await browserSnapshotFromTool(browser, computer, context, {})) as {
        elements: Array<{ ref: string; name: string }>;
      };
      const email = snap.elements.find((el) => el.name.includes("Email"))!.ref;
      const acted = await browserActFromTool(
        browser,
        computer,
        context,
        { actions: [{ kind: "fill_secret", ref: email, secret: "site_login", field: "username" }] },
        { resolveSecretFill: async () => ({ text: values.username, origin }) },
      );
      expect(acted).toMatchObject({ ok: false, completed: 0 });
      expect(JSON.stringify(acted)).toMatch(/HTTPS/);
      expect(JSON.stringify(acted)).not.toContain(values.username);
    });

    it("refuses to type a saved login on another origin", async () => {
      const browser = loginPage("https://phish.example.test/signin");
      const { email } = await refs(browser, "https://phish.example.test/signin");
      const acted = await browserActFromTool(
        browser,
        computer,
        context,
        { actions: [{ kind: "fill_secret", ref: email, secret: "site_login", field: "username" }] },
        { resolveSecretFill },
      );
      expect(acted).toMatchObject({ ok: false, completed: 0 });
      expect(JSON.stringify(acted)).toMatch(/not on the site/);
    });

    it("acts on nothing when a saved login cannot be resolved", async () => {
      const browser = loginPage("https://login.example.test/signin");
      const { email, password } = await refs(browser, "https://login.example.test/signin");
      const acted = await browserActFromTool(browser, computer, context, {
        actions: [
          { kind: "fill", ref: email, text: "typed-before" },
          { kind: "fill_secret", ref: password, secret: "site_login", field: "password" },
        ],
      });
      expect(acted).toEqual({
        ok: false,
        completed: 0,
        error: "Saved logins are unavailable here.",
      });
      const snap = await browserSnapshotFromTool(browser, computer, context, {});
      expect(JSON.stringify(snap)).not.toContain("typed-before");
    });
  });

  it("toggles checkboxes via click without undoing activation", async () => {
    const browser = new FakeBrowserProvider({
      pages: {
        "https://example.test/form": {
          title: "Form",
          html: `<!doctype html><html><head><title>Form</title></head><body>
            <label><input type="checkbox" aria-label="Agree" /> Agree</label>
          </body></html>`,
        },
      },
    });
    await browserNavigateFromTool(browser, computer, context, { url: "https://example.test/form" });
    const before = await browserSnapshotFromTool(browser, computer, context, {});
    const agree = (
      before as { elements: Array<{ ref: string; name: string; value?: string }> }
    ).elements.find((el) => el.name.includes("Agree"))!;
    expect(agree.value).toMatch(/unchecked|false|^$/i);
    const acted = await browserActFromTool(browser, computer, context, {
      actions: [{ kind: "click", ref: agree.ref }],
    });
    expect(acted).toMatchObject({ ok: true });
    const after = await browserSnapshotFromTool(browser, computer, context, {});
    const toggled = (after as { elements: Array<{ name: string; value?: string }> }).elements.find(
      (el) => el.name.includes("Agree"),
    )!;
    expect(toggled.value).toMatch(/checked|true/i);
  });

  it("falls back to computer_act for link navigation the in-process page cannot load", async () => {
    const browser = new FakeBrowserProvider({
      pages: {
        "https://example.test/start": {
          title: "Start",
          html: `<!doctype html><html><head><title>Start</title></head><body>
            <a href="https://example.test/next">Next</a>
          </body></html>`,
        },
      },
    });
    await browserNavigateFromTool(browser, computer, context, {
      url: "https://example.test/start",
    });
    const snap = await browserSnapshotFromTool(browser, computer, context, {});
    const link = (snap as { elements: Array<{ ref: string; name: string }> }).elements.find((el) =>
      el.name.includes("Next"),
    )!;
    const acted = await browserActFromTool(browser, computer, context, {
      actions: [{ kind: "click", ref: link.ref }],
    });
    expect(acted).toMatchObject({
      ok: false,
      fallback: "computer_act",
      error: expect.stringMatching(/cannot navigate links|computer_act/i),
    });
  });

  it("surfaces computer_act fallback from the tool layer", async () => {
    const browser = new FakeBrowserProvider();
    browser.forceFallback = "cannot attach to page";
    const result = await browserNavigateFromTool(browser, computer, context, {
      url: "https://example.test",
    });
    expect(result).toMatchObject({
      fallback: "computer_act",
      note: expect.stringMatching(/computer_act/i),
    });
  });

  it("hides page browser tools when the computer is not graphical", () => {
    const tools = [...PAGE_BROWSER_TOOL_NAMES].map((name) => ({ name }));
    expect(filterPageBrowserTools(tools, true)).toHaveLength(3);
    expect(filterPageBrowserTools(tools, false)).toEqual([]);
    expect(filterPageBrowserTools([{ name: "computer_act" }, ...tools], false)).toEqual([
      { name: "computer_act" },
    ]);
  });
});
