import { readFileSync } from "node:fs";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

/** The live page helper's isolated-world script, executed here rather than reimplemented. */
function installPageHelper(url: string, html: string) {
  const source = readFileSync(
    new URL("../../../infra/sandboxes/computer/rakazo-page-browser", import.meta.url),
    "utf8",
  );
  const match = source.match(/EVAL_HELPERS = r"""\n([\s\S]*?)\n"""/);
  if (!match?.[1]) throw new Error("page browser helper script was not found");
  const dom = new JSDOM(
    `<!doctype html><html><head><title>Sign in</title></head><body>${html}</body></html>`,
    {
      url,
      pretendToBeVisual: true,
      runScripts: "outside-only",
    },
  );
  const domWindow = dom.window;
  const elementPrototype = domWindow.Element.prototype as unknown as {
    getBoundingClientRect: () => unknown;
  };
  elementPrototype.getBoundingClientRect = () => ({
    width: 10,
    height: 10,
    top: 0,
    left: 0,
    right: 10,
    bottom: 10,
    x: 0,
    y: 0,
    toJSON() {
      return {};
    },
  });
  vm.runInContext(match[1], dom.getInternalVMContext());
  const browser = (
    domWindow as unknown as {
      __rakazoPageBrowser: {
        snapshot: () => {
          elements: Array<{ ref: string; name: string; role: string; value?: string }>;
        };
        fill: (ref: string, value: string, origin?: string) => { url: string };
      };
    }
  ).__rakazoPageBrowser;
  return { domWindow, browser };
}

function fieldValue(window: JSDOM["window"], label: string): string {
  const field = window.document.querySelector(`[aria-label="${label}"]`) as {
    value?: string;
  } | null;
  return field?.value ?? "";
}

function refFor(name: string, elements: Array<{ ref: string; name: string }>) {
  const match = elements.find((element) => element.name.includes(name));
  if (!match) throw new Error(`missing field ${name}`);
  return match.ref;
}

describe("live page helper saved-login fill", () => {
  const html = `
    <input aria-label="Email" />
    <input aria-label="Password" type="password" />
    <input aria-label="Phone" type="tel" />
    <textarea aria-label="Username"></textarea>
    <input aria-label="Query" type="search" />
    <input aria-label="Website" type="url" />
    <input aria-label="Pin" type="number" />
  `;

  it("types a login only into text, email, password, and tel inputs on the saved HTTPS origin", () => {
    const { domWindow, browser } = installPageHelper("https://login.example.test/signin", html);
    const snap = browser.snapshot();
    const origin = "https://login.example.test";
    browser.fill(refFor("Email", snap.elements), "fake-user", origin);
    browser.fill(refFor("Password", snap.elements), "fake-password", origin);
    browser.fill(refFor("Phone", snap.elements), "555", origin);
    expect(fieldValue(domWindow, "Email")).toBe("fake-user");
    expect(fieldValue(domWindow, "Phone")).toBe("555");
    for (const name of ["Username", "Query", "Website", "Pin"]) {
      expect(() => browser.fill(refFor(name, snap.elements), "leaked", origin)).toThrow(
        /text, email, password, or telephone/,
      );
    }
    expect(domWindow.document.body.textContent).not.toContain("leaked");
  });

  it("refuses a private-LAN HTTP origin in the same fill, even when the page matches", () => {
    const origin = "http://192.168.2.10:8080";
    const { domWindow, browser } = installPageHelper(`${origin}/signin`, html);
    const email = refFor("Email", browser.snapshot().elements);
    expect(() => browser.fill(email, "fake-user", origin)).toThrow(/HTTPS/);
    expect(fieldValue(domWindow, "Email")).toBe("");
  });
});

describe("live page helper upload targets", () => {
  it("lists hidden and role-overridden file inputs without crowding out page controls", () => {
    const hidden = Array.from(
      { length: 80 },
      (_, i) => `<input type="file" aria-label="Hidden ${i}" style="display:none" />`,
    ).join("");
    const { browser } = installPageHelper(
      "https://upload.example.test/",
      `${hidden}<input type="file" role="button" aria-label="Receipt" /><button>Save</button>`,
    );
    const { elements } = browser.snapshot();
    expect(elements.find((el) => el.name === "Save")?.role).toBe("button");
    expect(elements.find((el) => el.name === "Receipt")?.role).toBe("file upload");
    expect(elements.filter((el) => el.role === "file upload")).toHaveLength(81);
  });
});
