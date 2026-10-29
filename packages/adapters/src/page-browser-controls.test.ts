import { readFileSync } from "node:fs";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import { browserResultForModel } from "./browser-tools.js";
import { serializeToolResult } from "./pi-runtime-tools.js";

type Snapshot = {
  elements: Array<{
    ref: string;
    name: string;
    role: string;
    value?: string;
    options?: Array<{ label: string; value: string; selected?: boolean; disabled?: boolean }>;
  }>;
  tree: string;
};

/** The live page helper's isolated-world script, executed here rather than reimplemented. */
function installPageHelper(
  html: string,
  elementAt?: (dom: JSDOM, x: number, y: number) => unknown,
  random?: number,
) {
  const source = readFileSync(
    new URL("../../../infra/sandboxes/computer/rakazo-page-browser", import.meta.url),
    "utf8",
  );
  const match = source.match(/EVAL_HELPERS = r"""\n([\s\S]*?)\n"""/);
  if (!match?.[1]) throw new Error("page browser helper script was not found");
  const dom = new JSDOM(
    `<!doctype html><html><head><title>Portal</title></head><body>${html}</body></html>`,
    {
      url: "https://portal.example.test/",
      pretendToBeVisual: true,
      runScripts: "outside-only",
    },
  );
  const win = dom.window;
  // jsdom has no layout: every element is a 10 px square unless data-rect="left,top,width,height".
  (win.Element.prototype as unknown as { getBoundingClientRect: unknown }).getBoundingClientRect =
    function (this: Element) {
      const [left = 0, top = 0, width = 10, height = 10] = (
        this.getAttribute("data-rect") ?? "0,0,10,10"
      )
        .split(",")
        .map(Number);
      return {
        width,
        height,
        top,
        left,
        right: left + width,
        bottom: top + height,
        x: left,
        y: top,
      };
    };
  (win.Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = () => {};
  // jsdom has no innerText either.
  Object.defineProperty(win.HTMLElement.prototype, "innerText", {
    get(this: HTMLElement) {
      return this.textContent ?? "";
    },
  });
  (win.Element.prototype as unknown as { getClientRects: unknown }).getClientRects = function (
    this: Element,
  ) {
    return [this.getBoundingClientRect()];
  };
  (win.document as unknown as { elementFromPoint: unknown }).elementFromPoint = (
    x: number,
    y: number,
  ) => (elementAt ? elementAt(dom, x, y) : null);
  if (random !== undefined) win.Math.random = () => random;
  vm.runInContext(match[1], dom.getInternalVMContext());
  const browser = (
    win as unknown as {
      __rakazoPageBrowser: {
        snapshot: () => Snapshot;
        resolve: (ref: string) => unknown;
        aim: (ref: string) => { x: number | null; y: number | null };
        stillAimed: (ref: string, x: number, y: number) => { x: number; y: number };
        fill: (ref: string, value: string, origin?: string, field?: string) => unknown;
        quietFor: () => number;
      };
    }
  ).__rakazoPageBrowser;
  return { win, dom, browser };
}

const refOf = (snap: Snapshot, name: string) => {
  const found = snap.elements.find((el) => el.name === name);
  if (!found) throw new Error(`missing ${name}`);
  return found.ref;
};

const links = (count: number, parent: string) =>
  `<${parent}>${Array.from({ length: count }, (_, i) => `<a href="#p${i}">Page ${i}</a>`).join("")}</${parent}>`;

describe("live page helper refs", () => {
  it("hands out short refs that no later snapshot reuses", () => {
    const { browser } = installPageHelper(`<button>One</button><button>Two</button>`);
    const first = browser.snapshot();
    const second = browser.snapshot();
    const refs = [...first.elements, ...second.elements].map((el) => el.ref);
    expect(refs.every((ref) => /^e\d{1,9}$/.test(ref))).toBe(true);
    expect(new Set(refs).size).toBe(4);
    expect(() => browser.resolve(first.elements[0]!.ref)).toThrow(/Settled: Stale element ref/);
    expect(browser.resolve(second.elements[0]!.ref)).toBeTruthy();
  });
});

describe("live page helper refs across pages", () => {
  it("starts every page from another point, so a ref from the page before names nothing", () => {
    const firsts = Array.from({ length: 5 }, () => {
      const { browser } = installPageHelper(`<button>One</button>`);
      return browser.snapshot().elements[0]!.ref;
    });
    expect(new Set(firsts).size).toBe(5);
    expect(firsts.every((ref) => /^e\d{1,9}$/.test(ref))).toBe(true);
  });
});

describe("live page helper ref ranges", () => {
  it("counts up from a random point up to a hundred million, and pages do not overlap in practice", () => {
    const refs = (random: number) => {
      const { browser } = installPageHelper(
        `<button>One</button><button>Two</button>`,
        undefined,
        random,
      );
      return browser.snapshot().elements.map((el) => Number(el.ref.slice(1)));
    };
    expect(refs(0.5)).toEqual([50_000_001, 50_000_002]);
    expect(refs(0)).toEqual([1, 2]);
    expect(refs(0.99999999)).toEqual([100_000_000, 100_000_001]);
    // The lowest start a page can have is far above the few thousand refs a page hands out in a visit.
    const [first] = refs(0.00001);
    expect(first).toBeGreaterThan(1000);
  });
});

describe("live page helper settled step errors", () => {
  it("tells a stale, hidden or disabled element apart, as settled errors", () => {
    const { win, browser } = installPageHelper(
      `<button id="gone">Gone</button><button id="shy">Shy</button><button id="off">Off</button>`,
    );
    const snap = browser.snapshot();
    win.document.getElementById("gone")!.remove();
    (win.document.getElementById("shy") as HTMLElement).style.display = "none";
    (win.document.getElementById("off") as HTMLButtonElement).disabled = true;
    expect(() => browser.resolve(refOf(snap, "Gone"))).toThrow(/Settled: Stale element ref/);
    expect(() => browser.resolve(refOf(snap, "Shy"))).toThrow(/Settled: Element is hidden/);
    expect(() => browser.resolve(refOf(snap, "Off"))).toThrow(/Settled: Element is disabled/);
    expect(() => browser.resolve("e1")).toThrow(/Settled: Stale element ref/);
  });
});

describe("live page helper dropdowns", () => {
  const html = `<label for="year">Year</label>
    <select id="year">
      <option value="">Choose</option>
      <option value="p23">שנת 2023</option>
      <option value="p24" selected>שנת&nbsp;2024</option>
      <option value="p25" disabled>2025</option>
    </select>`;

  it("lists a select's options with label, value and the chosen one", () => {
    const { browser } = installPageHelper(html);
    const snap = browser.snapshot();
    const year = snap.elements.find((el) => el.name === "Year")!;
    expect(year.options).toEqual([
      { label: "Choose", value: "" },
      { label: "שנת 2023", value: "p23" },
      { label: "שנת 2024", value: "p24", selected: true },
      { label: "2025", value: "p25", disabled: true },
    ]);
    expect(snap.tree).toContain(
      'options: "Choose"="", "שנת 2023"="p23", "שנת 2024"="p24" (selected), "2025"="p25" (disabled)',
    );
  });

  it("fills with an option's visible label, its value, or the label ignoring case and spacing", () => {
    const { win, browser } = installPageHelper(html);
    const select = win.document.getElementById("year") as HTMLSelectElement;
    const changes: string[] = [];
    select.addEventListener("change", () => changes.push(select.value));
    const ref = refOf(browser.snapshot(), "Year");
    browser.fill(ref, "שנת 2023");
    expect(select.value).toBe("p23");
    browser.fill(ref, "p24");
    expect(select.value).toBe("p24");
    browser.fill(ref, "  שנת   2023 ");
    expect(select.value).toBe("p23");
    browser.fill(ref, "CHOOSE");
    expect(select.value).toBe("");
    expect(changes).toEqual(["p23", "p24", "p23", ""]);
  });

  it("fills with a long option's label as the snapshot cut it", () => {
    const long =
      "Annual report including every regional office, subsidiary, partner and joint venture";
    const { win, browser } = installPageHelper(
      `<label for="r">Report</label><select id="r"><option>Short</option><option>${long} 2023</option><option>${long} 2024</option><option>${long}, all years combined</option></select>`,
    );
    const snap = browser.snapshot();
    const options = snap.elements.find((el) => el.name === "Report")?.options ?? [];
    const select = win.document.getElementById("r") as HTMLSelectElement;
    expect(new Set(options.map((option) => option.label)).size).toBe(4);
    browser.fill(refOf(snap, "Report"), options[3]!.label);
    expect(select.value).toBe(`${long}, all years combined`);
    browser.fill(refOf(snap, "Report"), options[1]!.label);
    expect(select.value).toBe(`${long} 2023`);
  });

  it("refuses an option the select does not have, listing the ones it has", () => {
    const { win, browser } = installPageHelper(html);
    const ref = refOf(browser.snapshot(), "Year");
    expect(() => browser.fill(ref, "2019")).toThrow(
      /Settled: This dropdown has no option "2019"\. Its options: "Choose"="", "שנת 2023"="p23"/,
    );
    expect(() => browser.fill(ref, "2025")).toThrow(/Settled: The option "2025" is disabled/);
    expect((win.document.getElementById("year") as HTMLSelectElement).value).toBe("p24");
  });
});

describe("live page helper snapshot limits", () => {
  it("says how many controls it shows and keeps the ones the page is about", () => {
    const { browser } = installPageHelper(
      `<header>${links(100, "nav")}</header><main><button data-rect="0,100,10,10">Choose year</button></main>`,
    );
    const snap = browser.snapshot();
    expect(snap.elements).toHaveLength(80);
    expect(snap.tree).toContain("[controls: showing 80 of 101]");
    // Page order is kept, and the button after 100 menu links is among the 80.
    expect(snap.elements.map((el) => el.name)).toContain("Choose year");
    expect(snap.elements.findIndex((el) => el.name === "Choose year")).toBe(79);
  });

  it("puts an open dialog or popup before the page and what is on screen before what is not", () => {
    const { browser } = installPageHelper(
      `${links(90, "nav")}<div role="listbox">${["2021", "2022"].map((y) => `<div role="option" data-rect="0,5000,10,10">${y}</div>`).join("")}</div>
       <button data-rect="0,5000,10,10">Far below</button><button data-rect="0,10,10,10">On screen</button>`,
    );
    const names = browser.snapshot().elements.map((el) => el.name);
    expect(names).toContain("2021");
    expect(names).toContain("2022");
    expect(names).toContain("On screen");
    expect(names).not.toContain("Far below");
  });

  it("de-prioritises cookie banners and tabindex=-1 wrappers", () => {
    const { browser } = installPageHelper(
      `<div id="cookie-banner">${Array.from({ length: 40 }, (_, i) => `<button>Cookie ${i}</button>`).join("")}</div>
       <div tabindex="-1">Wrapper text <button>Inside</button></div>
       ${Array.from({ length: 60 }, (_, i) => `<button>Main ${i}</button>`).join("")}`,
    );
    const snap = browser.snapshot();
    const names = snap.elements.map((el) => el.name);
    expect(names).toContain("Main 59");
    expect(names.filter((name) => name.startsWith("Cookie"))).toHaveLength(80 - 61);
    expect(names.some((name) => name.startsWith("Wrapper"))).toBe(false);
  });

  it("gives refs to clickable elements that are not buttons or links", () => {
    const { browser } = installPageHelper(
      `<div onclick="x()">Inline handler</div>
       <li role="option">Role option</li>
       <div style="cursor: pointer"><span>Pointer card</span></div>
       <div>Plain text</div>`,
    );
    const names = browser.snapshot().elements.map((el) => el.name);
    expect(names).toEqual(["Inline handler", "Role option", "Pointer card"]);
  });

  it("says how much page text was cut", () => {
    const { browser } = installPageHelper(`<p>${"x".repeat(12345)}</p><button>Go</button>`);
    expect(browser.snapshot().tree).toMatch(
      /^\[page text: showing first \d{4} of 12347 characters\]\n/,
    );
    expect(installPageHelper(`<p>short</p>`).browser.snapshot().tree).not.toContain("[page text");
  });
});

describe("live page helper click aim", () => {
  it("aims at the element's centre when it is what the page would reach there", () => {
    const { browser } = installPageHelper(
      `<button data-rect="100,200,40,20">Open</button>`,
      (dom) => dom.window.document.querySelector("button"),
    );
    expect(browser.aim(refOf(browser.snapshot(), "Open"))).toEqual({ x: 120, y: 210 });
  });

  it("names what covers an element instead of clicking through it", () => {
    const { browser } = installPageHelper(
      `<button data-rect="100,200,40,20">Open</button><div role="dialog" aria-label="Cookies" data-rect="0,0,500,500"></div>`,
      (dom) => dom.window.document.querySelector("[role=dialog]"),
    );
    expect(() => browser.aim(refOf(browser.snapshot(), "Open"))).toThrow(
      /Settled: Element is covered by dialog "Cookies"/,
    );
  });

  it("scrolls the element into the middle of the view before it aims", () => {
    const { win, browser } = installPageHelper(
      `<button data-rect="100,200,40,20">Open</button>`,
      (dom) => dom.window.document.querySelector("button"),
    );
    const calls: unknown[] = [];
    (win.Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = (
      arg: unknown,
    ) => calls.push(arg);
    browser.aim(refOf(browser.snapshot(), "Open"));
    expect(calls).toEqual([{ block: "center", inline: "center", behavior: "instant" }]);
  });

  it("clicks the label of a checkbox kept out of sight, which is what reaches it", () => {
    const { win, browser } = installPageHelper(
      `<label data-rect="200,300,100,30"><input type="checkbox" data-rect="0,0,1,1" /><span>Agree to terms</span></label>`,
      (dom) => dom.window.document.querySelector("span"),
    );
    const scrolled: Element[] = [];
    (win.Element.prototype as unknown as { scrollIntoView: unknown }).scrollIntoView = function (
      this: Element,
    ) {
      scrolled.push(this);
    };
    const ref = refOf(browser.snapshot(), "Agree to terms");
    // The pointer goes to the middle of the label, not to the one-pixel input.
    expect(browser.aim(ref)).toEqual({ x: 250, y: 315 });
    expect(scrolled.map((el) => el.tagName)).toEqual(["LABEL"]);
    // And the check after the pointer moved accepts a spot anywhere inside that label.
    expect(browser.stillAimed(ref, 250, 315)).toEqual({ x: 0, y: 0 });
  });

  it("aims at a part of the label that is not a link or button inside it", () => {
    // The label is 200..300 wide; a "Terms" link sits in its middle (240..260).
    const { browser } = installPageHelper(
      `<label data-rect="200,300,100,30"><input type="checkbox" data-rect="0,0,1,1" /><span>I accept the</span> <a href="/terms" data-rect="240,300,20,30">Terms</a></label>`,
      (dom, x) => dom.window.document.querySelector(x >= 240 && x < 260 ? "a" : "span"),
    );
    const ref = refOf(browser.snapshot(), "I accept the Terms");
    const { x } = browser.aim(ref);
    expect(x!).toBeGreaterThanOrEqual(200);
    expect(x!).toBeLessThan(300);
    expect(x! < 240 || x! >= 260).toBe(true);
    // The pointer must not be left over the link.
    expect(() => browser.stillAimed(ref, 250, 315)).toThrow(
      /Settled: The page moved under the pointer: link "Terms"/,
    );
  });

  it("keeps off a label inside the label, which ticks another control", () => {
    // A second label (for another checkbox) covers the middle of the first (200..300).
    const { browser } = installPageHelper(
      `<label data-rect="200,300,100,30"><input type="checkbox" data-rect="0,0,1,1" /><span>Newsletter</span><label for="other" data-rect="240,300,20,30"><span>Partners</span></label></label><input id="other" type="checkbox" />`,
      (dom, x) =>
        dom.window.document.querySelector(
          x >= 240 && x < 260 ? "label label span" : "label > span",
        ),
    );
    const ref = refOf(browser.snapshot(), "NewsletterPartners");
    const { x } = browser.aim(ref);
    expect(x! < 240 || x! >= 260).toBe(true);
    expect(() => browser.stillAimed(ref, 250, 315)).toThrow(
      /Settled: The page moved under the pointer/,
    );
  });

  it("says so when every spot of the label is a link", () => {
    const { browser } = installPageHelper(
      `<label data-rect="200,300,100,30"><input type="checkbox" data-rect="0,0,1,1" /><a href="/terms" data-rect="200,300,100,30">Terms</a></label>`,
      (dom) => dom.window.document.querySelector("a"),
    );
    expect(() => browser.aim(refOf(browser.snapshot(), "Terms"))).toThrow(
      /Settled: Element is covered by link "Terms"/,
    );
  });

  it("accepts a click on something inside the label of a normal-sized control", () => {
    const { browser } = installPageHelper(
      `<label><input type="radio" data-rect="0,0,16,16" /><span>Monthly</span></label>`,
      (dom) => dom.window.document.querySelector("span"),
    );
    expect(browser.aim(refOf(browser.snapshot(), "Monthly"))).toEqual({ x: 8, y: 8 });
  });

  it("will not click into a frame, even one inside the element", () => {
    const { browser } = installPageHelper(
      `<div role="button" aria-label="Continue" data-rect="100,200,40,20"><iframe></iframe></div>`,
      (dom) => dom.window.document.querySelector("iframe"),
    );
    expect(() => browser.aim(refOf(browser.snapshot(), "Continue"))).toThrow(
      /Settled: That spot is inside a frame/,
    );
  });

  it("aims through an open shadow tree and accepts what is inside the element's own shadow", () => {
    const { win, browser } = installPageHelper(
      `<div role="button" aria-label="Menu" data-rect="100,200,40,20"></div>`,
      (dom) => dom.window.document.querySelector("[role=button]"),
    );
    const host = win.document.querySelector("[role=button]") as HTMLElement;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = "<span>label</span>";
    (shadow as unknown as { elementFromPoint: unknown }).elementFromPoint = () =>
      shadow.querySelector("span");
    expect(browser.aim(refOf(browser.snapshot(), "Menu"))).toEqual({ x: 120, y: 210 });
    // A frame in that shadow tree is found too.
    shadow.innerHTML = "<iframe></iframe>";
    (shadow as unknown as { elementFromPoint: unknown }).elementFromPoint = () =>
      shadow.querySelector("iframe");
    expect(() => browser.aim(refOf(browser.snapshot(), "Menu"))).toThrow(
      /Settled: That spot is inside a frame, which the page tools cannot click in\.$/,
    );
  });

  it("reports where the page is scrolled to, which the browser's own hit-test needs", () => {
    const { win, browser } = installPageHelper(
      `<button data-rect="100,200,40,20">Open</button>`,
      (dom) => dom.window.document.querySelector("button"),
    );
    Object.defineProperty(win, "pageXOffset", { configurable: true, value: 15 });
    Object.defineProperty(win, "pageYOffset", { configurable: true, value: 2251 });
    const ref = refOf(browser.snapshot(), "Open");
    const { x, y } = browser.aim(ref);
    expect(browser.stillAimed(ref, x!, y!)).toEqual({ x: 15, y: 2251 });
  });

  it("stops when the page put something else under the pointer after it moved", () => {
    let top = "button";
    const { browser } = installPageHelper(
      `<button data-rect="100,200,40,20">Next</button><button id="pay" data-rect="100,200,40,20">Confirm payment</button>`,
      (dom) => dom.window.document.querySelector(top === "button" ? "button" : "#pay"),
    );
    const ref = refOf(browser.snapshot(), "Next");
    const { x, y } = browser.aim(ref);
    expect(browser.stillAimed(ref, x!, y!)).toEqual({ x: 0, y: 0 });
    top = "pay";
    expect(() => browser.stillAimed(ref, x!, y!)).toThrow(
      /Settled: The page moved under the pointer: button "Confirm payment"/,
    );
  });

  it("only focuses a native select and refuses a click on a file upload", () => {
    const { browser } = installPageHelper(
      `<select aria-label="Year"><option>2024</option></select><input type="file" aria-label="Statement" />`,
    );
    const snap = browser.snapshot();
    expect(browser.aim(refOf(snap, "Year"))).toEqual({ x: null, y: null });
    expect(() => browser.aim(refOf(snap, "Statement"))).toThrow(/Settled: This is a file upload/);
  });
});

describe("live page helper dropdown choices", () => {
  it("replaces the old choice in a multiple select instead of adding to it", () => {
    const { win, browser } = installPageHelper(
      `<label for="m">Tags</label><select id="m" multiple><option selected>A</option><option selected>B</option><option>C</option></select>`,
    );
    const select = win.document.getElementById("m") as HTMLSelectElement;
    browser.fill(refOf(browser.snapshot(), "Tags"), "C");
    expect([...select.selectedOptions].map((o) => o.value)).toEqual(["C"]);
  });

  it("still replaces the old choice in a single select", () => {
    const { win, browser } = installPageHelper(
      `<label for="s">Year</label><select id="s"><option>2023</option><option selected>2024</option></select>`,
    );
    const select = win.document.getElementById("s") as HTMLSelectElement;
    browser.fill(refOf(browser.snapshot(), "Year"), "2023");
    expect(select.value).toBe("2023");
  });

  it("treats an option in a disabled group as disabled, in the list and when choosing", () => {
    const { win, browser } = installPageHelper(
      `<label for="g">Plan</label><select id="g"><option>Free</option><optgroup label="Soon" disabled><option>Pro</option></optgroup></select>`,
    );
    const snap = browser.snapshot();
    expect(snap.elements.find((el) => el.name === "Plan")?.options?.at(-1)).toEqual({
      label: "Pro",
      value: "Pro",
      disabled: true,
    });
    expect(() => browser.fill(refOf(snap, "Plan"), "Pro")).toThrow(
      /Settled: The option "Pro" is disabled/,
    );
    expect((win.document.getElementById("g") as HTMLSelectElement).value).toBe("Free");
  });
});

describe("live page helper control lines", () => {
  it("writes a control's name as a quoted string, so quotes, backslashes and line breaks survive", () => {
    const { browser } = installPageHelper(
      `<button>Export "2024"</button><button aria-label="C:\\temp">x</button><button aria-label="two\nlines">y</button>`,
    );
    const lines = browser
      .snapshot()
      .tree.split("\n")
      .filter((line) => line.startsWith("- button"));
    expect(lines.map((line) => line.replace(/ \[e\d+\]$/, ""))).toEqual([
      '- button "Export \\"2024\\""',
      '- button "C:\\\\temp"',
      '- button "two\\nlines"',
    ]);
  });
});

describe("live page helper long dropdowns", () => {
  const years = Array.from(
    { length: 5000 },
    (_, i) => `<option value="y${i}">Year ${i}</option>`,
  ).join("");
  const html = `<label for="y">Year</label><select id="y">${years}</select>`;

  it("lists the first options and the chosen one, and counts the rest", () => {
    const { win, browser } = installPageHelper(html);
    (win.document.getElementById("y") as HTMLSelectElement).selectedIndex = 4200;
    const snap = browser.snapshot();
    const year = snap.elements.find((el) => el.name === "Year") as Snapshot["elements"][number] & {
      optionsTotal?: number;
    };
    expect(year.options).toHaveLength(101);
    expect(year.options?.at(-1)).toEqual({ label: "Year 4200", value: "y4200", selected: true });
    expect(year.optionsTotal).toBe(5000);
    expect(snap.tree).toContain(", and 4899 more");
    expect(JSON.stringify(snap).length).toBeLessThan(30_000);
  });

  it("still fills any option by its label and lists only a few when it has none", () => {
    const { win, browser } = installPageHelper(html);
    const ref = refOf(browser.snapshot(), "Year");
    browser.fill(ref, "Year 4321");
    expect((win.document.getElementById("y") as HTMLSelectElement).value).toBe("y4321");
    expect(() => browser.fill(ref, "Year 9999")).toThrow(/Its options: .*, and 4899 more\./);
  });
});

describe("live page helper saved logins and cards", () => {
  const origin = "https://portal.example.test";
  const form = `<input aria-label="Email" type="email" /><input aria-label="Password" type="password" />
    <input aria-label="Notes" type="text" /><select aria-label="Plan"><option>Free</option></select>`;

  it("types a saved password only into a password field on its own HTTPS site", () => {
    const { win, browser } = installPageHelper(form);
    const snap = browser.snapshot();
    expect(() => browser.fill(refOf(snap, "Notes"), "fake-password", origin, "password")).toThrow(
      /Refused: A saved password can only be typed into a password field/,
    );
    expect(() => browser.fill(refOf(snap, "Plan"), "fake-password", origin, "password")).toThrow(
      /Refused: A saved password can only be typed into a password field/,
    );
    expect(() => browser.fill(refOf(snap, "Plan"), "fake-user", origin, "username")).toThrow(
      /Refused: A saved username can only be typed into a text, email, or telephone field/,
    );
    expect(() => browser.fill(refOf(snap, "Plan"), "4242", origin, "card")).toThrow(
      /Refused: A card can only be typed into a card field/,
    );
    expect(() =>
      browser.fill(
        refOf(snap, "Password"),
        "fake-password",
        "https://other.example.test",
        "password",
      ),
    ).toThrow(/Refused: The page is not on the site this login was saved for/);
    expect(() =>
      browser.fill(
        refOf(snap, "Password"),
        "fake-password",
        "http://portal.example.test",
        "password",
      ),
    ).toThrow(/Refused: Website logins can only be filled on HTTPS/);
    expect((win.document.querySelector("[aria-label=Password]") as HTMLInputElement).value).toBe(
      "",
    );
    browser.fill(refOf(snap, "Password"), "fake-password", origin, "password");
    expect((win.document.querySelector("[aria-label=Password]") as HTMLInputElement).value).toBe(
      "fake-password",
    );
  });

  it("never shows a saved login's value in a snapshot, and shows a plain fill's", () => {
    const { browser } = installPageHelper(form);
    const first = browser.snapshot();
    browser.fill(refOf(first, "Email"), "fake-user@example.test", origin, "username");
    browser.fill(refOf(first, "Notes"), "plain note");
    const next = browser.snapshot();
    expect(JSON.stringify(next)).not.toContain("fake-user@example.test");
    expect(next.elements.find((el) => el.name === "Notes")?.value).toBe("plain note");
  });
});

describe("what the model reads of a dense page", () => {
  /** The page tool result as the model's text carries it, and whether the shortener would touch it. */
  const asRead = (snapshot: Snapshot) => {
    const result = {
      ok: true,
      url: "https://portal.example.test/",
      title: "Portal",
      completed: 1,
      ...snapshot,
    };
    const view = browserResultForModel(result) as {
      content: Array<{ text: string }>;
      details: unknown;
    };
    const text = view.content[0]!.text;
    return {
      text,
      details: view.details,
      result,
      full: serializeToolResult(result, undefined, "browser_snapshot", {}),
    };
  };
  const rows = Array.from(
    { length: 400 },
    (_, i) => `<p>שורה ${i} של טבלת תשואות מפורטת לפי מסלול</p>`,
  ).join("");
  const buttons = Array.from({ length: 150 }, (_, i) => `<button>פעולה מספר ${i}</button>`).join(
    "",
  );

  it("keeps the notices, the controls and the page in one piece under the limit", () => {
    const { browser } = installPageHelper(`<h1>Returns</h1>${rows}${buttons}`);
    const { text, details, result, full } = asRead(browser.snapshot());
    expect(text.length).toBeLessThanOrEqual(12_000);
    // Sent whole, the same page is over the limit and the generic shortener cuts the middle of its tree.
    expect(JSON.stringify(result).length).toBeGreaterThan(12_000);
    expect(full).toContain("omitted evidence is unavailable");
    expect(text).not.toContain("omitted evidence");
    const tree = (JSON.parse(text) as { tree: string }).tree;
    // The notices open the tree, ahead of anything that could be cut.
    expect(tree.startsWith("[controls: showing ")).toBe(true);
    expect(tree).toMatch(
      /^\[controls: showing \d+ of 150\]\n\[page text: showing first \d+ of \d+ characters\]\n/,
    );
    expect(tree).toContain("[e");
    // The elements are not sent twice; they stay in the details.
    expect(text).not.toContain('"elements"');
    expect(details).toBe(result);
    expect((details as { elements: unknown[] }).elements.length).toBeGreaterThan(20);
  });

  it("lists every control it says it shows, with its ref", () => {
    const { browser } = installPageHelper(`${rows}${buttons}`);
    const snap = browser.snapshot();
    const { text } = asRead(snap);
    const tree = (JSON.parse(text) as { tree: string }).tree;
    const shown = Number(/controls: showing (\d+) of/.exec(tree)![1]);
    expect(snap.elements).toHaveLength(shown);
    for (const element of snap.elements) expect(tree).toContain(`[${element.ref}]`);
  });

  it("keeps a 1500-option dropdown small: a few options, the total and the chosen one", () => {
    const options = Array.from(
      { length: 1500 },
      (_, i) => `<option value="v${i}">אפשרות מספר ${i}</option>`,
    ).join("");
    const { browser, win } = installPageHelper(
      `<label for="s">בחירה</label><select id="s">${options}</select>`,
    );
    (win.document.getElementById("s") as HTMLSelectElement).selectedIndex = 1200;
    const { text, details } = asRead(browser.snapshot());
    expect(text.length).toBeLessThanOrEqual(12_000);
    expect(Number(/and (\d+) more/.exec(text)?.[1])).toBeGreaterThanOrEqual(1399);
    expect(text).toContain("אפשרות מספר 1200");
    const select = (details as { elements: Array<{ options: unknown[]; optionsTotal: number }> })
      .elements[0]!;
    expect(select.options).toHaveLength(101);
    expect(select.optionsTotal).toBe(1500);
  });

  it("sends a page as it is when it is larger than the limit anyway (an older computer image)", () => {
    const result = { ok: true, url: "u", title: "t", tree: "x".repeat(13_000), elements: [] };
    expect(browserResultForModel(result)).toBe(result);
    expect(browserResultForModel({ error: "boom" })).toEqual({ error: "boom" });
  });
});
