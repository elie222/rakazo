import { readFileSync } from "node:fs";
import vm from "node:vm";
import { JSDOM } from "jsdom";
import { describe, expect, it, vi } from "vitest";
import { resolveRequestSecretDestination } from "./bot-secrets.js";

/** page_secrets' isolated-world script, executed here rather than reimplemented. */
function installPageHelper(url: string, html: string) {
  const source = readFileSync(
    new URL("../../../infra/sandboxes/computer/page_secrets.py", import.meta.url),
    "utf8",
  );
  const match = source.match(/EVAL_HELPERS = r"""\n([\s\S]*?)\n"""/);
  if (!match?.[1]) throw new Error("page secrets script was not found");
  const dom = new JSDOM(
    `<!doctype html><html><head><title>Sign in</title></head><body>${html}</body></html>`,
    { url, pretendToBeVisual: true, runScripts: "outside-only" },
  );
  const domWindow = dom.window;
  // jsdom has no layout: every element is a 10 px square.
  (
    domWindow.Element.prototype as unknown as { getBoundingClientRect: unknown }
  ).getBoundingClientRect = () => ({
    width: 10,
    height: 10,
    top: 0,
    left: 0,
    right: 10,
    bottom: 10,
    x: 0,
    y: 0,
  });
  vm.runInContext(match[1], dom.getInternalVMContext());
  const secrets = (
    domWindow as unknown as {
      __rakazoPageBrowser: {
        findCard: (token: string) => number;
        focusCard: () => boolean;
        cardHolds: () => boolean;
        cardTyped: (length: number) => boolean;
        emptyCard: () => void;
        fill: (value: string, origin?: string, field?: string) => boolean;
      };
    }
  ).__rakazoPageBrowser;
  // The page browser focuses the field the bot pointed to; the fill then takes the focused field.
  const browser = {
    ...secrets,
    fill(label: string, value: string, origin?: string, field?: string) {
      (domWindow.document.querySelector(`[aria-label="${label}"]`) as HTMLElement).focus();
      return secrets.fill(value, origin as string, field as string);
    },
  };
  return { domWindow, browser };
}

function fieldValue(window: JSDOM["window"], label: string): string {
  const field = window.document.querySelector(`[aria-label="${label}"]`) as {
    value?: string;
  } | null;
  return field?.value ?? "";
}

function filled(window: JSDOM["window"], label: string) {
  return window.document
    .querySelector(`[aria-label="${label}"]`)!
    .hasAttribute("data-rakazo-filled");
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
    browser.fill("Email", "fake-user", origin, "username");
    browser.fill("Phone", "555", origin, "username");
    expect(fieldValue(domWindow, "Email")).toBe("fake-user");
    expect(fieldValue(domWindow, "Phone")).toBe("555");
    for (const name of ["Password", "Username", "Query", "Website", "Pin"]) {
      expect(() => browser.fill(name, "fake-name", origin, "username")).toThrow(
        /text, email, or telephone/,
      );
    }
    expect(fieldValue(domWindow, "Password")).toBe("");
  });

  it("types a password only into a password field, also when the field is not named", () => {
    const { domWindow, browser } = installPageHelper(`${origin}/signin`, html);
    for (const name of ["Email", "Phone", "Username", "Query", "Website", "Pin"]) {
      for (const field of ["password", undefined]) {
        expect(() => browser.fill(name, "fake-password", origin, field)).toThrow(/password field/);
      }
    }
    expect(domWindow.document.body.innerHTML).not.toContain("fake-password");
    browser.fill("Password", "fake-password", origin, "password");
    expect(fieldValue(domWindow, "Password")).toBe("fake-password");
    // Marked, so the page browser's snapshots never show it.
    expect(filled(domWindow, "Password")).toBe(true);
  });

  function passwordField(domWindow: JSDOM["window"]) {
    return domWindow.document.querySelector('[aria-label="Password"]') as HTMLInputElement;
  }

  it("preserves a revealed password while keeping its value out of snapshots", async () => {
    const { domWindow, browser } = installPageHelper(`${origin}/signin`, html);
    const field = passwordField(domWindow);
    field.addEventListener("input", () => (field.type = "text"), { once: true });
    const ref = "Password";
    browser.fill(ref, "fake-password", origin, "password");
    await Promise.resolve();
    expect(field.type).toBe("text");
    expect(field.value).toBe("fake-password");
    // Snapshots still never report it.
    expect(filled(domWindow, "Password")).toBe(true);
  });

  it("refuses a password field that the page turns into text when it is focused", () => {
    const { domWindow, browser } = installPageHelper(`${origin}/signin`, html);
    const field = passwordField(domWindow);
    field.addEventListener("focus", () => (field.type = "text"));
    const ref = "Password";
    expect(() => browser.fill(ref, "fake-password", origin, "password")).toThrow(/password field/);
    expect(field.value).toBe("");
  });

  it("leaves nothing of a login that the field only partly accepts", () => {
    const { domWindow, browser } = installPageHelper(
      `${origin}/signin`,
      '<input aria-label="Email" type="email" />',
    );
    const ref = "Email";
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
    other.browser.fill("Email", "fake-user", origin, "username");
    expect(fieldValue(other.domWindow, "Email")).toBe("fake-user");
    for (const url of ["https://example.test/login", "https://www.example.test.evil.test/login"]) {
      const { domWindow, browser } = installPageHelper(url, html);
      const email = "Email";
      expect(() => browser.fill(email, "fake-user", origin, "username")).toThrow(/not on the site/);
      expect(fieldValue(domWindow, "Email")).toBe("");
    }
  });

  it("refuses a private-LAN HTTP origin in the same fill, even when the page matches", () => {
    const origin = "http://192.168.2.10:8080";
    const { domWindow, browser } = installPageHelper(`${origin}/signin`, html);
    const email = "Email";
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
    browser.fill("Card number", number, origin, "card");
    browser.fill("Phone", number, origin, "card");
    browser.fill("Security code", "123", origin, "card");
    expect(fieldValue(domWindow, "Card number")).toBe(number);
    expect(fieldValue(domWindow, "Security code")).toBe("123");
    expect(filled(domWindow, "Card number")).toBe(true);
    expect(filled(domWindow, "Security code")).toBe(true);
  });

  it("draws a filled card as dots on screen until a saved login replaces it", () => {
    const { domWindow, browser } = installPageHelper(`${origin}/pay`, html);
    const ref = "Card number";
    const input = domWindow.document.querySelector<HTMLInputElement>('[aria-label="Card number"]')!;
    // jsdom drops vendor properties, so watch the CSSOM calls Chrome applies.
    const set = vi.spyOn(input.style, "setProperty");
    const remove = vi.spyOn(input.style, "removeProperty");
    browser.fill(ref, number, origin, "card");
    expect(set).toHaveBeenCalledWith("-webkit-text-security", "disc", "important");
    expect(remove).not.toHaveBeenCalled();
    browser.fill(ref, "fake-user", origin, "username");
    expect(remove).toHaveBeenCalledWith("-webkit-text-security");
  });

  it("refuses any other field, with card wording", () => {
    const { domWindow, browser } = installPageHelper(`${origin}/pay`, html);
    for (const name of ["Email", "Query", "Pin", "Notes", "Country", "Editor"]) {
      expect(() => browser.fill(name, number, origin, "card"), name).toThrow(
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
      const ref = "Card number";
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
    const ref = "Card number";
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
    expect(browser.findCard("cc-number")).toBe(1);
    const field = domWindow.document.querySelector<HTMLInputElement>('[aria-label="Card number"]')!;
    const mask = vi.spyOn(field.style, "setProperty");
    expect(browser.focusCard()).toBe(true);
    expect(mask).toHaveBeenCalledWith("-webkit-text-security", "disc", "important");
    expect(browser.cardHolds()).toBe(true);
    field.value = "4242 4242 4242 4242";
    expect(browser.cardTyped(16)).toBe(true);
    expect(browser.cardTyped(15)).toBe(false);
    expect(filled(domWindow, "Card number")).toBe(true);
    domWindow.document.querySelector<HTMLInputElement>('[aria-label="Email"]')!.focus();
    expect(browser.cardHolds()).toBe(false);
    browser.emptyCard();
    expect(field.value).toBe("");
  });

  it("is refused by a helper that reads an unknown field as a password, outside password inputs", () => {
    // An older helper treats "card" like a password; a card number field is never one.
    const { browser } = installPageHelper(`${origin}/pay`, html);
    const ref = "Card number";
    expect(() => browser.fill(ref, number, origin, "unknown-field")).toThrow(/password field/);
  });
});
