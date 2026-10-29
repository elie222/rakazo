import { readFileSync } from "node:fs";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { resolveRequestSecretDestination } from "./bot-secrets.js";

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
    getBoundingClientRect: (this: Element) => unknown;
  };
  // jsdom has no layout: every element is a 10 px square unless data-rect="left,top,width,height".
  elementPrototype.getBoundingClientRect = function () {
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
      toJSON() {
        return {};
      },
    };
  };
  vm.runInContext(match[1], dom.getInternalVMContext());
  const browser = (
    domWindow as unknown as {
      __rakazoPageBrowser: {
        snapshot: () => {
          elements: Array<{ ref: string; name: string; role: string; value?: string }>;
          tree: string;
          frames: boolean;
        };
        findCard: (token: string) => number;
        hasCardField: () => boolean;
        focusCard: () => boolean;
        cardHolds: () => boolean;
        cardTyped: (length: number) => boolean;
        emptyCard: () => void;
        fill: (ref: string, value: string, origin?: string, field?: string) => { url: string };
        focusForKeys: (ref: string, whole?: boolean) => { focused: boolean };
        focusHolds: () => boolean;
        typed: (ref: string, text: string) => boolean;
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

  const origin = "https://login.example.test";

  it("types a username only into text, email, and tel inputs on the saved HTTPS origin", () => {
    const { domWindow, browser } = installPageHelper(`${origin}/signin`, html);
    const snap = browser.snapshot();
    browser.fill(refFor("Email", snap.elements), "fake-user", origin, "username");
    browser.fill(refFor("Phone", snap.elements), "555", origin, "username");
    expect(fieldValue(domWindow, "Email")).toBe("fake-user");
    expect(fieldValue(domWindow, "Phone")).toBe("555");
    for (const name of ["Password", "Username", "Query", "Website", "Pin"]) {
      expect(() =>
        browser.fill(refFor(name, snap.elements), "fake-name", origin, "username"),
      ).toThrow(/text, email, or telephone/);
    }
    expect(fieldValue(domWindow, "Password")).toBe("");
  });

  it("types a password only into a password field, also when the field is not named", () => {
    const { domWindow, browser } = installPageHelper(`${origin}/signin`, html);
    const snap = browser.snapshot();
    for (const name of ["Email", "Phone", "Username", "Query", "Website", "Pin"]) {
      for (const field of ["password", undefined]) {
        expect(() =>
          browser.fill(refFor(name, snap.elements), "fake-password", origin, field),
        ).toThrow(/password field/);
      }
    }
    expect(domWindow.document.body.innerHTML).not.toContain("fake-password");
    expect(JSON.stringify(browser.snapshot())).not.toContain("fake-password");
    browser.fill(
      refFor("Password", browser.snapshot().elements),
      "fake-password",
      origin,
      "password",
    );
    expect(fieldValue(domWindow, "Password")).toBe("fake-password");
    expect(JSON.stringify(browser.snapshot())).not.toContain("fake-password");
  });

  function passwordField(domWindow: JSDOM["window"]) {
    return domWindow.document.querySelector('[aria-label="Password"]') as HTMLInputElement;
  }

  it("preserves a revealed password while keeping its value out of snapshots", async () => {
    const { domWindow, browser } = installPageHelper(`${origin}/signin`, html);
    const field = passwordField(domWindow);
    field.addEventListener("input", () => (field.type = "text"), { once: true });
    const ref = refFor("Password", browser.snapshot().elements);
    browser.fill(ref, "fake-password", origin, "password");
    await Promise.resolve();
    expect(field.type).toBe("text");
    expect(field.value).toBe("fake-password");
    // Snapshots still never report it.
    expect(JSON.stringify(browser.snapshot())).not.toContain("fake-password");
  });

  it("refuses a password field that the page turns into text when it is focused", () => {
    const { domWindow, browser } = installPageHelper(`${origin}/signin`, html);
    const field = passwordField(domWindow);
    field.addEventListener("focus", () => (field.type = "text"));
    const ref = refFor("Password", browser.snapshot().elements);
    expect(() => browser.fill(ref, "fake-password", origin, "password")).toThrow(/password field/);
    expect(field.value).toBe("");
  });

  it("leaves nothing of a login that the field only partly accepts", () => {
    const { domWindow, browser } = installPageHelper(
      `${origin}/signin`,
      '<input aria-label="Email" type="email" />',
    );
    const ref = refFor("Email", browser.snapshot().elements);
    // Email fields trim surrounding spaces, so the value read back differs from the one set.
    // Settled like the other refusals: no desktop fallback, which can't type a saved login.
    expect(() => browser.fill(ref, " fake-user ", origin, "username")).toThrow(
      /^Refused: This field didn't accept the saved login, so it was cleared\.$/,
    );
    expect(fieldValue(domWindow, "Email")).toBe("");
  });

  it("fills a login saved from a page URL only on that page's exact site", () => {
    const origin = resolveRequestSecretDestination({
      label: "Sign in",
      purpose: "password",
      credential: {
        name: "site_login",
        origin: "https://www.example.test/some/login/page?x=1",
        auth: { type: "login" },
      },
    }).destination?.origin;
    expect(origin).toBe("https://www.example.test");
    const other = installPageHelper("https://www.example.test/other", html);
    other.browser.fill(
      refFor("Email", other.browser.snapshot().elements),
      "fake-user",
      origin,
      "username",
    );
    expect(fieldValue(other.domWindow, "Email")).toBe("fake-user");
    for (const url of ["https://example.test/login", "https://www.example.test.evil.test/login"]) {
      const { domWindow, browser } = installPageHelper(url, html);
      const email = refFor("Email", browser.snapshot().elements);
      expect(() => browser.fill(email, "fake-user", origin, "username")).toThrow(/not on the site/);
      expect(fieldValue(domWindow, "Email")).toBe("");
    }
  });

  it("refuses a private-LAN HTTP origin in the same fill, even when the page matches", () => {
    const origin = "http://192.168.2.10:8080";
    const { domWindow, browser } = installPageHelper(`${origin}/signin`, html);
    const email = refFor("Email", browser.snapshot().elements);
    expect(() => browser.fill(email, "fake-user", origin)).toThrow(/HTTPS/);
    expect(fieldValue(domWindow, "Email")).toBe("");
  });
});

describe("live page helper card fill", () => {
  const html = `
    <input aria-label="Card number" />
    <input aria-label="Phone" type="tel" />
    <input aria-label="Security code" type="password" />
    <input aria-label="Email" type="email" />
    <input aria-label="Query" type="search" />
    <input aria-label="Pin" type="number" />
    <textarea aria-label="Notes"></textarea>
    <select aria-label="Country"><option>US</option></select>
    <div aria-label="Editor" contenteditable="true" role="textbox"></div>
  `;
  const origin = "https://shop.example.test";
  const number = "4242424242424242";

  it("types a card into text, tel, and password inputs on the merchant's HTTPS origin, hidden", () => {
    const { domWindow, browser } = installPageHelper(`${origin}/pay`, html);
    const snap = browser.snapshot();
    browser.fill(refFor("Card number", snap.elements), number, origin, "card");
    browser.fill(refFor("Phone", snap.elements), number, origin, "card");
    browser.fill(refFor("Security code", snap.elements), "123", origin, "card");
    expect(fieldValue(domWindow, "Card number")).toBe(number);
    expect(fieldValue(domWindow, "Security code")).toBe("123");
    expect(JSON.stringify(browser.snapshot())).not.toContain(number);
    expect(JSON.stringify(browser.snapshot())).not.toContain('"123"');
  });

  it("draws a filled card as dots on screen until the field is filled with something else", () => {
    const { domWindow, browser } = installPageHelper(`${origin}/pay`, html);
    const ref = refFor("Card number", browser.snapshot().elements);
    const input = domWindow.document.querySelector<HTMLInputElement>('[aria-label="Card number"]')!;
    // jsdom drops vendor properties, so watch the CSSOM calls Chrome applies.
    const set = vi.spyOn(input.style, "setProperty");
    const remove = vi.spyOn(input.style, "removeProperty");
    browser.fill(ref, number, origin, "card");
    expect(set).toHaveBeenCalledWith("-webkit-text-security", "disc", "important");
    expect(remove).not.toHaveBeenCalled();
    browser.fill(ref, "plain text");
    expect(remove).toHaveBeenCalledWith("-webkit-text-security");
  });

  it("refuses any other field, with card wording", () => {
    const { domWindow, browser } = installPageHelper(`${origin}/pay`, html);
    const snap = browser.snapshot();
    for (const name of ["Email", "Query", "Pin", "Notes", "Country", "Editor"]) {
      expect(() => browser.fill(refFor(name, snap.elements), number, origin, "card"), name).toThrow(
        /^Refused: A card can only be typed into a card field\.$/,
      );
    }
    expect(domWindow.document.body.innerHTML).not.toContain(number);
  });

  it("refuses another site, plain HTTP, and a card without its origin", () => {
    for (const [url, saved, error] of [
      ["https://shop.example.test.evil.test/pay", origin, /not on the merchant's site/],
      ["http://shop.example.test/pay", "http://shop.example.test", /only be filled on HTTPS/],
      [`${origin}/pay`, undefined, /only be filled on HTTPS/],
    ] as const) {
      const { domWindow, browser } = installPageHelper(url, html);
      const ref = refFor("Card number", browser.snapshot().elements);
      expect(() => browser.fill(ref, number, saved, "card"), url).toThrow(error);
      expect(fieldValue(domWindow, "Card number"), url).toBe("");
    }
  });

  it("clears a card the field only partly accepts", () => {
    const { domWindow, browser } = installPageHelper(`${origin}/pay`, html);
    const field = domWindow.document.querySelector<HTMLInputElement>('[aria-label="Card number"]')!;
    // A page script that formats the number as it is set changes what reads back.
    const setter = Object.getOwnPropertyDescriptor(domWindow.HTMLInputElement.prototype, "value")!;
    Object.defineProperty(field, "value", {
      get: () => setter.get!.call(field).slice(0, 12),
      set: (value: string) => setter.set!.call(field, value),
    });
    const ref = refFor("Card number", browser.snapshot().elements);
    expect(() => browser.fill(ref, number, origin, "card")).toThrow(
      /^Refused: This field didn't accept the card, so it was cleared\.$/,
    );
    expect(setter.get!.call(field)).toBe("");
  });

  it("finds the one visible card field by its autocomplete token for a fill without a ref", () => {
    const { domWindow, browser } = installPageHelper(
      `${origin}/pay`,
      `<input aria-label="Autofill" autocomplete="cc-number" aria-hidden="true" />
        <input aria-label="Faded" autocomplete="cc-exp" style="opacity: 0" />
        <input aria-label="Email" autocomplete="cc-csc" type="email" />
        <input aria-label="Card number" autocomplete="section-pay billing CC-Number" />
        <input aria-label="Postal" autocomplete="postal-code" /><input autocomplete="postal-code" />
        <iframe></iframe>`,
    );
    expect(browser.findCard("cc-exp")).toBe(0);
    expect(browser.findCard("cc-csc")).toBe(0);
    expect(browser.findCard("postal-code")).toBe(2);
    expect(browser.focusCard()).toBe(false);
    expect(browser.hasCardField()).toBe(true);
    expect(browser.findCard("cc-number")).toBe(1);
    const field = domWindow.document.querySelector<HTMLInputElement>('[aria-label="Card number"]')!;
    const mask = vi.spyOn(field.style, "setProperty");
    expect(browser.focusCard()).toBe(true);
    expect(mask).toHaveBeenCalledWith("-webkit-text-security", "disc", "important");
    expect(browser.cardHolds()).toBe(true);
    field.value = "4242 4242 4242 4242";
    expect(browser.cardTyped(16)).toBe(true);
    expect(browser.cardTyped(15)).toBe(false);
    const snapshot = browser.snapshot();
    expect(snapshot.frames).toBe(true);
    expect(JSON.stringify(snapshot)).not.toContain("4242 4242");
    expect(JSON.stringify(snapshot)).not.toContain("4242424242424242");
    domWindow.document.querySelector<HTMLInputElement>('[aria-label="Email"]')!.focus();
    expect(browser.cardHolds()).toBe(false);
    browser.emptyCard();
    expect(field.value).toBe("");
  });

  it("is refused by a helper that reads an unknown field as a password, outside password inputs", () => {
    // An older helper treats "card" like a password; a card number field is never one.
    const { browser } = installPageHelper(`${origin}/pay`, html);
    const ref = refFor("Card number", browser.snapshot().elements);
    expect(() => browser.fill(ref, number, origin, "unknown-field")).toThrow(/password field/);
  });
});

describe("live page helper code fields", () => {
  it("lists a transparent one-time-code input under drawn boxes, and nothing else hidden", () => {
    const { browser } = installPageHelper(
      "https://code.example.test/",
      `<input aria-label="Code" autocomplete="one-time-code" style="opacity:0" />
        <input autocomplete="one-time-code" style="opacity:0" />
        <input aria-label="Hidden note" style="opacity:0" />
        <input aria-label="Gone" autocomplete="one-time-code" style="display:none" />`,
    );
    const names = browser.snapshot().elements.map((el) => el.name);
    expect(names).toEqual(["Code", "One-time code"]);
  });

  // Six boxes on one row; `top` places the row on the page.
  const row = (name: string, top: number, attributes = 'maxlength="1"', width = 10) =>
    Array.from(
      { length: 6 },
      (_, i) =>
        `<input aria-label="${name} ${i + 1}" ${attributes} value="${i}" data-rect="${i * 20},${top},${width},10" />`,
    ).join("");
  function typeInto(html: string, name: string) {
    const { domWindow, browser } = installPageHelper("https://code.example.test/", html);
    const { focused } = browser.focusForKeys(refFor(name, browser.snapshot().elements));
    const values = (prefix: string) =>
      Array.from(
        domWindow.document.querySelectorAll<HTMLInputElement>(`[aria-label^="${prefix}"]`),
        (input) => input.value,
      ).join("");
    return { domWindow, browser, focused, values };
  }

  it("empties only the boxes of the code being typed, never another code or field", () => {
    // Two codes on different rows inside one wrapper, and a one-letter field beside them.
    const stacked = typeInto(
      `<main><div>${row("Text", 0)}</div><div>${row("Email", 50)}</div>
        <input aria-label="Initial" maxlength="1" value="Q" data-rect="0,100,10,10" /></main>`,
      "Text 4",
    );
    expect(stacked.focused).toBe(true);
    expect(stacked.values("Text")).toBe("");
    expect(stacked.values("Email")).toBe("012345");
    expect(stacked.values("Initial")).toBe("Q");
    expect(stacked.domWindow.document.activeElement?.getAttribute("aria-label")).toBe("Text 1");
    // Two forms side by side on the same row.
    const sideBySide = typeInto(
      `<div><form>${row("Left", 0)}</form><form>${row("Right", 0)}</form></div>`,
      "Left 1",
    );
    expect([sideBySide.values("Left"), sideBySide.values("Right")]).toEqual(["", "012345"]);
    // Boxes in the same form as a password take in only each other.
    const nextToPassword = typeInto(
      `<form><input aria-label="Password" type="password" value="pw" data-rect="0,0,200,10" />${row("Pin", 0)}</form>`,
      "Pin 1",
    );
    expect(nextToPassword.values("Pin")).toBe("");
    expect(
      nextToPassword.domWindow.document.querySelector<HTMLInputElement>('[type="password"]')?.value,
    ).toBe("pw");
  });

  it("empties a row of equal narrow boxes without a one-character limit, but not two short fields", () => {
    expect(typeInto(`<div>${row("Box", 0, "")}</div>`, "Box 3").values("Box")).toBe("");
    const date = typeInto(
      `<div><input aria-label="Day" maxlength="2" value="24" data-rect="0,0,20,10" />
        <input aria-label="Month" maxlength="2" value="10" data-rect="30,0,20,10" /></div>`,
      "Day",
    );
    expect([date.values("Day"), date.values("Month")]).toEqual(["", "10"]);
  });

  it("keeps typing while focus moves between the code's boxes, and stops anywhere else", () => {
    const { domWindow, browser } = typeInto(
      `<div>${row("Code", 0)}</div><input aria-label="Email" data-rect="0,50,200,10" />`,
      "Code 1",
    );
    const focus = (name: string) =>
      domWindow.document.querySelector<HTMLInputElement>(`[aria-label="${name}"]`)?.focus();
    expect(browser.focusHolds()).toBe(true);
    focus("Code 4");
    expect(browser.focusHolds()).toBe(true);
    focus("Email");
    expect(browser.focusHolds()).toBe(false);
    focus("Code 5");
    domWindow.document.querySelector("div")?.remove();
    expect(browser.focusHolds()).toBe(false);
  });

  it("leaves a one-letter field just before the code out of it, by its name or its size", () => {
    const named = typeInto(
      `<div><input aria-label="Middle initial" maxlength="1" value="Q" data-rect="0,0,10,10" />${row("Digit", 0)}</div>`,
      "Digit 1",
    );
    expect(named.focused).toBe(true);
    expect([named.values("Middle"), named.values("Digit")]).toEqual(["Q", ""]);
    expect(named.domWindow.document.activeElement?.getAttribute("aria-label")).toBe("Digit 1");
    // Typing into the one-letter field itself empties only that field.
    const own = typeInto(
      `<div><input aria-label="Middle initial" maxlength="1" value="Q" data-rect="0,0,10,10" />${row("Digit", 0)}</div>`,
      "Middle initial",
    );
    expect([own.values("Middle"), own.values("Digit")]).toEqual(["", "012345"]);
    const wider = typeInto(
      `<div><input maxlength="1" placeholder="M" value="Q" data-rect="0,0,30,10" />${Array.from(
        { length: 6 },
        (_, i) =>
          `<input maxlength="1" placeholder="-" value="${i}" data-rect="${40 + i * 20},0,10,10" />`,
      ).join("")}</div>`,
      "-",
    );
    const inputs = Array.from(
      wider.domWindow.document.querySelectorAll("input"),
      (input) => (input as HTMLInputElement).value,
    );
    expect(inputs).toEqual(["Q", "", "", "", "", "", ""]);
  });

  it("keeps a wrapped final digit with its named code", () => {
    const wrapped = typeInto(
      `<div><input aria-label="Middle initial" maxlength="1" value="Q" />${row("Digit", 0).replace("100,0,10,10", "0,20,10,10")}</div>`,
      "Digit 1",
    );
    expect([wrapped.values("Middle"), wrapped.values("Digit")]).toEqual(["Q", ""]);
    const last =
      wrapped.domWindow.document.querySelector<HTMLInputElement>('[aria-label="Digit 6"]')!;
    last.focus();
    expect(wrapped.browser.focusHolds()).toBe(true);
  });

  it("still joins a code split into three-box subgroups", () => {
    const boxes = row("Digit", 0)
      .split(" />")
      .filter(Boolean)
      .map((box) => `${box} />`);
    const split = typeInto(
      `<div><span>${boxes.slice(0, 3).join("")}</span>-<span>${boxes.slice(3).join("")}</span></div>`,
      "Digit 4",
    );
    expect(split.values("Digit")).toBe("");
    expect(split.domWindow.document.activeElement?.getAttribute("aria-label")).toBe("Digit 1");
  });

  it("joins a code split into four-box subgroups and keeps typing through both", () => {
    const boxes = Array.from(
      { length: 8 },
      (_, i) => `<input aria-label="Digit ${i + 1}" maxlength="1" value="${i}" />`,
    );
    const { domWindow, browser, values } = typeInto(
      `<div><span>${boxes.slice(0, 4).join("")}</span>-<span>${boxes.slice(4).join("")}</span></div>`,
      "Digit 5",
    );
    expect(values("Digit")).toBe("");
    const inputs = Array.from(domWindow.document.querySelectorAll("input"));
    expect(domWindow.document.activeElement).toBe(inputs[0]);
    for (const [i, digit] of Array.from("48291375").entries()) {
      inputs[i]!.focus();
      expect(browser.focusHolds()).toBe(true);
      inputs[i]!.value = digit;
      inputs[i]!.dispatchEvent(new domWindow.Event("input", { bubbles: true }));
    }
    expect(values("Digit")).toBe("48291375");
    expect(browser.typed(refFor("Digit 5", browser.snapshot().elements), "48291375")).toBe(true);
  });

  it("keeps adjacent same-named codes in their own containers", () => {
    const { domWindow, browser } = installPageHelper(
      "https://code.example.test/",
      `<form><div>${row("Digit", 0)}</div><div>${row("Digit", 0)}</div></form>`,
    );
    browser.focusForKeys(browser.snapshot().elements[8]!.ref);
    const groups = domWindow.document.querySelectorAll("div");
    const values = (group: Element) =>
      Array.from(group.querySelectorAll("input"), (box) => box.value).join("");
    expect([values(groups[0]!), values(groups[1]!)]).toEqual(["012345", ""]);
    expect(domWindow.document.activeElement).toBe(groups[1]!.firstElementChild);
  });

  it.each([
    ["shared id prefix", (i: number) => `id="otp-1-${i}"`],
    ["shared name prefix", (i: number) => `name="code1_digit${i}"`],
    ["React ids", (i: number) => `id=":r${i + 1}:"`],
    ["shared React id", (_: number) => 'id=":r1:"'],
    ["React ids with suffix", (i: number) => `id=":r5:-input${i}"`],
    ["generated ids", (i: number) => `id="input-${[17, 23, 19, 31, 28, 42][i]}"`],
    ["labels with total", (i: number) => `aria-label="Digit ${i + 1} of 6"`],
    ["labels with shared total first", (i: number) => `aria-label="6-digit code, digit ${i + 1}"`],
  ])("keeps a single code together with %s", (_, attributes) => {
    const { domWindow, browser } = installPageHelper(
      "https://code.example.test/",
      `<div>${Array.from(
        { length: 6 },
        (_, i) =>
          `<input ${attributes(i)} maxlength="1" value="${i}" data-rect="${i * 20},0,10,10" />`,
      ).join("")}</div>`,
    );
    browser.focusForKeys(browser.snapshot().elements[3]!.ref);
    const inputs = Array.from(domWindow.document.querySelectorAll("input"));
    expect(inputs.map((box) => box.value)).toEqual(Array(6).fill(""));
    expect(domWindow.document.activeElement).toBe(inputs[0]);
    for (const input of inputs) {
      input.focus();
      expect(browser.focusHolds()).toBe(true);
    }
  });

  it("joins consecutively numbered boxes across a wide gap", () => {
    const { domWindow, browser, values } = typeInto(
      `<div>${Array.from(
        { length: 6 },
        (_, i) =>
          `<input aria-label="Digit ${i + 1}" maxlength="1" value="${i}" data-rect="${i * 40 + (i >= 3 ? 96 : 0)},0,40,40" />`,
      ).join("")}</div>`,
      "Digit 4",
    );
    expect(values("Digit")).toBe("");
    const inputs = Array.from(domWindow.document.querySelectorAll("input"));
    expect(domWindow.document.activeElement).toBe(inputs[0]);
    for (const input of inputs) {
      input.focus();
      expect(browser.focusHolds()).toBe(true);
    }
  });

  it("joins name-only numbered boxes across a wide gap", () => {
    const { domWindow, browser } = installPageHelper(
      "https://code.example.test/",
      `<div>${Array.from(
        { length: 6 },
        (_, i) =>
          `<input name="otp-${i + 1}" maxlength="1" value="${i}" data-rect="${i * 40 + (i >= 3 ? 96 : 0)},0,40,40" />`,
      ).join("")}</div>`,
    );
    browser.focusForKeys(browser.snapshot().elements[3]!.ref);
    const inputs = Array.from(domWindow.document.querySelectorAll("input"));
    expect(inputs.map((box) => box.value)).toEqual(Array(6).fill(""));
    expect(domWindow.document.activeElement).toBe(inputs[0]);
    for (const input of inputs) {
      input.focus();
      expect(browser.focusHolds()).toBe(true);
    }
  });

  it.each([
    ["labels", (i: number) => `aria-label="Digit ${(i % 6) + 1}"`],
    ["names", (i: number) => `name="otp-${(i % 6) + 1}"`],
  ] as const)("types both codes across wide gaps with restarting %s", (_, attributes) => {
    const { domWindow, browser } = installPageHelper(
      "https://code.example.test/",
      `<div>${Array.from(
        { length: 12 },
        (_, i) =>
          `<input ${attributes(i)} maxlength="1" value="${i % 6}" data-rect="${Math.floor(i / 6) * 400 + (i % 6) * 40 + (i % 6 >= 3 ? 96 : 0)},0,40,40" />`,
      ).join("")}</div>`,
    );
    const inputs = Array.from(domWindow.document.querySelectorAll("input"));
    const refs = browser.snapshot().elements.map((element) => element.ref);
    const values = () => [
      inputs
        .slice(0, 6)
        .map((box) => box.value)
        .join(""),
      inputs
        .slice(6)
        .map((box) => box.value)
        .join(""),
    ];
    for (const offset of [6, 0]) {
      const ref = refs[offset + 3]!;
      expect(browser.focusForKeys(ref).focused).toBe(true);
      expect(values()).toEqual(offset === 6 ? ["012345", ""] : ["", "482913"]);
      expect(domWindow.document.activeElement).toBe(inputs[offset]);
      for (const [i, digit] of Array.from("482913").entries()) {
        const box = inputs[offset + i]!;
        box.focus();
        expect(browser.focusHolds()).toBe(true);
        box.value = digit;
        box.dispatchEvent(new domWindow.Event("input", { bubbles: true }));
      }
      expect(browser.typed(ref, "482913")).toBe(true);
      expect(values()).toEqual(offset === 6 ? ["012345", "482913"] : ["482913", "482913"]);
    }
  });

  it("keeps a code together across a dash with a two-box-wide separator", () => {
    const boxes = Array.from(
      { length: 6 },
      (_, i) =>
        `${i === 3 ? "<span>-</span>" : ""}<input maxlength="1" value="${i}" data-rect="${i * 20 + (i >= 3 ? 10 : 0)},0,10,10" />`,
    ).join("");
    const { domWindow, browser } = installPageHelper(
      "https://code.example.test/",
      `<div>${boxes}</div>`,
    );
    browser.focusForKeys(browser.snapshot().elements[4]!.ref);
    expect(Array.from(domWindow.document.querySelectorAll("input"), (box) => box.value)).toEqual(
      Array(6).fill(""),
    );
  });

  it.each([
    // Named "Digit 1" to "Digit 6" twice, side by side.
    [
      "box numbers start again",
      `${row("Digit", 0)}${row("Digit", 0).replace(/data-rect="(\d+)/g, (_, x) => `data-rect="${Number(x) + 120}`)}`,
    ],
    [
      "zero-based box numbers start again",
      `${row("Digit", 0)}${row("Digit", 0).replace(/data-rect="(\d+)/g, (_, x) => `data-rect="${Number(x) + 120}`)}`.replace(
        /aria-label="Digit (\d)"/g,
        (_, digit) => `aria-label="Digit ${Number(digit) - 1}"`,
      ),
    ],
    ...(
      [
        ["consecutive generated ids", (i: number) => `id="input-${i + 17}"`],
        ["numbered names", (i: number) => `name="otp-${(i % 6) + 1}"`],
        ["names continue across a wide gap", (i: number) => `name="otp-${i + 1}"`],
        ["labels continue across a wide gap", (i: number) => `aria-label="Digit ${i + 1}"`],
        ["labels starting above one", (i: number) => `aria-label="Digit ${i + 17}"`],
      ] as const
    ).map(([description, attributes]) => [
      description,
      Array.from(
        { length: 12 },
        (_, i) =>
          `<input ${attributes(i)} maxlength="1" value="${i % 6}" data-rect="${i < 6 ? i * 20 : 300 + (i - 6) * 20},0,10,10" />`,
      ).join(""),
    ]),
    // Unnamed, with a wide gap between the two codes.
    [
      "a wide gap follows",
      Array.from(
        { length: 12 },
        (_, i) =>
          `<input maxlength="1" value="${i % 6}" data-rect="${i < 6 ? i * 20 : 300 + (i - 6) * 20},0,10,10" />`,
      ).join(""),
    ],
  ])("keeps two codes in one container apart where %s", (_, boxes) => {
    const { domWindow, browser } = installPageHelper(
      "https://code.example.test/",
      `<div>${boxes}</div>`,
    );
    browser.focusForKeys(browser.snapshot().elements[6]!.ref);
    const inputs = Array.from(domWindow.document.querySelectorAll("input"));
    expect(inputs.map((box) => box.value).join("")).toBe("012345");
    expect(domWindow.document.activeElement).toBe(inputs[6]);
    inputs[6]!.value = "9";
    inputs[6]!.dispatchEvent(new domWindow.Event("input", { bubbles: true }));
    expect(
      inputs
        .slice(0, 6)
        .map((box) => box.value)
        .join(""),
    ).toBe("012345");
    expect(
      inputs
        .slice(6)
        .map((box) => box.value)
        .join(""),
    ).toBe("9");
  });

  it.each([false, true])(
    "stops when another widget replaces the target (same container: %s)",
    (sameContainer) => {
      const { domWindow, browser } = typeInto(
        `<main><div>${row("Code", 0)}</div></main>`,
        "Code 1",
      );
      const group = domWindow.document.querySelector("div")!;
      if (sameContainer) group.innerHTML = row("Other", 0);
      else group.outerHTML = `<div>${row("Code", 0)}</div>`;
      domWindow.document.querySelector<HTMLInputElement>("input")!.focus();
      expect(browser.focusHolds()).toBe(false);
      expect(
        Array.from(domWindow.document.querySelectorAll("input"), (box) => box.value).join(""),
      ).toBe("012345");
    },
  );

  it("lets a code be typed box by box, with or without the widget moving on", () => {
    for (const advances of [false, true]) {
      const { domWindow, browser } = installPageHelper(
        "https://code.example.test/",
        `<div>${row("Digit", 0).replace(/value="\d"/g, 'value=""')}</div>`,
      );
      const document = domWindow.document;
      const boxes = Array.from(document.querySelectorAll("input"));
      if (advances) {
        for (const [i, box] of boxes.entries()) {
          box.addEventListener("input", () => {
            if (box.value) boxes[i + 1]?.focus();
          });
        }
      }
      const refs = browser.snapshot().elements.map((element) => element.ref);
      for (const [i, digit] of Array.from("482913").entries()) {
        // One character typed into each box, as a keyboard would put it there.
        expect(browser.focusForKeys(refs[i]!, false).focused, `box ${i + 1}`).toBe(true);
        const active = document.activeElement as HTMLInputElement;
        active.value = digit;
        active.dispatchEvent(new domWindow.Event("input", { bubbles: true }));
        expect(browser.typed(refs[i]!, digit)).toBe(true);
      }
      expect(boxes.map((box) => box.value).join(""), advances ? "auto-advance" : "plain").toBe(
        "482913",
      );
      // A whole code typed again still replaces every box.
      browser.focusForKeys(refs[3]!, true);
      expect(boxes.map((box) => box.value).join("")).toBe("");
      expect(document.activeElement).toBe(boxes[0]);
    }
  });

  it("types into a code whose widget replaces its boxes on every input", () => {
    const { domWindow, browser } = installPageHelper(
      "https://code.example.test/",
      `<div>${row("Code", 0)}</div>`,
    );
    const document = domWindow.document;
    const group = document.querySelector("div") as HTMLDivElement;
    // Like a widget that renders its boxes again from its own state, focusing the same place.
    group.addEventListener("input", (event) => {
      const at = Array.prototype.indexOf.call(group.children, event.target);
      const focused = Array.prototype.indexOf.call(group.children, document.activeElement);
      for (const old of Array.from(group.children) as HTMLInputElement[]) {
        const box = old.cloneNode() as HTMLInputElement;
        box.value = old.value;
        old.replaceWith(box);
      }
      (group.children[focused >= 0 ? focused : at] as HTMLInputElement | undefined)?.focus();
    });
    const ref = refFor("Code 3", browser.snapshot().elements);
    const { focused } = browser.focusForKeys(ref);
    expect(focused).toBe(true);
    expect(Array.from(group.children, (box) => (box as HTMLInputElement).value).join("")).toBe("");
    expect(document.activeElement).toBe(group.children[0]);
    // The widget moves on to its next box, which it has just created again.
    group.children[0]?.dispatchEvent(new domWindow.Event("input", { bubbles: true }));
    (group.children[1] as HTMLInputElement).focus();
    expect(browser.focusHolds()).toBe(true);
    // What landed is read from the new boxes.
    for (const [i, box] of Array.from(group.children).entries())
      (box as HTMLInputElement).value = "482913"[i]!;
    expect([browser.typed(ref, "482913"), browser.typed(ref, "111111")]).toEqual([true, false]);
    // An empty widget sees no events from emptying it.
    const quiet = installPageHelper(
      "https://code.example.test/",
      `<div>${row("Code", 0, 'maxlength="1"').replace(/value="\d"/g, 'value=""')}</div>`,
    );
    let events = 0;
    quiet.domWindow.document.addEventListener("input", () => events++);
    expect(
      quiet.browser.focusForKeys(refFor("Code 1", quiet.browser.snapshot().elements)).focused,
    ).toBe(true);
    expect(events).toBe(0);
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

describe("live page helper referenced names", () => {
  it("resolves label references in order, including hidden text, and falls back when empty", () => {
    const { domWindow, browser } = installPageHelper(
      "https://example.test/",
      `
      <span id="first" hidden>  Share </span><span id="second"> with   team </span><span id="empty"> </span>
      <button aria-labelledby=" second missing first " aria-label="Other"></button>
      <button aria-labelledby=" missing " aria-label="Fallback"></button>
      <button aria-labelledby="   " aria-label="Whitespace fallback"></button>
      <button aria-labelledby="empty" aria-label="Empty fallback"></button>
    `,
    );
    expect(browser.snapshot().elements.map((element) => element.name)).toEqual([
      "with team Share",
      "Fallback",
      "Whitespace fallback",
      "Empty fallback",
    ]);
    domWindow.close();
  });
});

describe("live page helper shadow-root names", () => {
  it("resolves upload labels only within each input's root", () => {
    const { domWindow, browser } = installPageHelper(
      "https://example.test/",
      `<span id="label">Outer label</span><span id="outer-only">Outer only</span><button aria-labelledby="inner-only" aria-label="Light fallback"></button><div id="host"></div>`,
    );
    const host = domWindow.document.getElementById("host")!;
    const root = host.attachShadow({ mode: "open" });
    root.innerHTML = `
      <span id="label" hidden>Inner label</span><span id="inner-only">Inner only</span>
      <input type="file" aria-labelledby="label" aria-label="Fallback one" />
      <input type="file" aria-labelledby="outer-only" aria-label="Fallback two" />
    `;
    expect(
      browser
        .snapshot()
        .elements.filter((element) => element.role === "file upload")
        .map((element) => element.name),
    ).toEqual(["Inner label", "Fallback two"]);
    expect(browser.snapshot().elements.find((element) => element.role === "button")?.name).toBe(
      "Light fallback",
    );
    domWindow.close();
  });
});
