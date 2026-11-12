import { SIGNUP_ATTRIBUTION_COOKIE, SIGNUP_SURFACE_HEADER } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { rememberSignupAttribution } from "./browser-signup-attribution.js";
import { signupAttributionFromCookie, signupAttributionFromHeaders } from "./signup-attribution.js";

function browser(href: string, referrer = "") {
  let cookie = "";
  const writes: string[] = [];
  return {
    location: { href },
    document: {
      referrer,
      get cookie() {
        return cookie;
      },
      set cookie(value: string) {
        writes.push(value);
        cookie = value.split(";")[0]!;
      },
    },
    writes,
  };
}

describe("signup acquisition", () => {
  it("keeps shared-hosting tenants separate for cookies and referrers", () => {
    const page = browser(
      "https://app.example.github.io/?utm_source=community",
      "https://other.github.io/",
    );
    rememberSignupAttribution(page, "web");
    expect(page.writes[0]).toContain("; Domain=example.github.io");
    expect(signupAttributionFromCookie(page.document.cookie)).toEqual({
      surface: "web",
      utmSource: "community",
      referringDomain: "other.github.io",
    });
  });
  it("carries the first campaign from marketing to signup without storing raw URLs", () => {
    const page = browser(
      "https://example.com/?utm_source=newsletter&utm_campaign=launch&click_id=private",
      "https://search.example.test/path?email=private@example.test",
    );
    rememberSignupAttribution(page);
    expect(page.writes[0]).toContain("; Domain=example.com");
    expect(page.writes[0]).toContain("; Secure");
    page.location.href = "https://app.example.com/sign-in?utm_source=other";
    page.document.referrer = "https://example.com/";
    rememberSignupAttribution(page, "web");
    expect(signupAttributionFromCookie(page.document.cookie)).toEqual({
      surface: "web",
      utmSource: "newsletter",
      utmCampaign: "launch",
      referringDomain: "search.example.test",
    });
    expect(page.document.cookie).not.toContain("private");
    rememberSignupAttribution(page, "web");
    expect(page.writes).toHaveLength(2);
  });

  it("drops invalid campaign values and internal referrers, retaining valid fields", () => {
    const page = browser(
      `https://app.example.com/?utm_source=person%40example.test&utm_medium=email&utm_campaign=${"a".repeat(101)}&utm_term=https%3A%2F%2Fexample.test`,
      "https://example.com/",
    );
    rememberSignupAttribution(page, "desktop");
    expect(signupAttributionFromCookie(page.document.cookie)).toEqual({
      surface: "desktop",
      utmMedium: "email",
    });
  });

  it("allows a direct visit to acquire its first campaign later", () => {
    const page = browser("http://localhost:3000/sign-in");
    rememberSignupAttribution(page, "web");
    expect(page.writes[0]).not.toContain("Domain=");
    page.location.href += "?utm_source=community";
    rememberSignupAttribution(page, "web");
    expect(signupAttributionFromCookie(page.document.cookie)).toEqual({
      surface: "web",
      utmSource: "community",
    });
  });

  it("uses the native request's surface and rejects malformed or oversized cookies", () => {
    const cookie = `${SIGNUP_ATTRIBUTION_COOKIE}=${encodeURIComponent(JSON.stringify({ surface: "web", utmSource: "community" }))}`;
    expect(
      signupAttributionFromHeaders(new Headers({ cookie, [SIGNUP_SURFACE_HEADER]: "ios" })),
    ).toEqual({ surface: "ios", utmSource: "community" });
    expect(signupAttributionFromCookie(`${SIGNUP_ATTRIBUTION_COOKIE}=%bad`)).toEqual({});
    expect(signupAttributionFromCookie(`${SIGNUP_ATTRIBUTION_COOKIE}=${"x".repeat(3001)}`)).toEqual(
      {},
    );
    expect(signupAttributionFromHeaders(new Headers({ [SIGNUP_SURFACE_HEADER]: "other" }))).toEqual(
      {},
    );
  });

  it("does not break authentication when cookie access is blocked", () => {
    const page = browser("https://app.example.com/");
    Object.defineProperty(page.document, "cookie", {
      get: () => {
        throw new Error("blocked");
      },
    });
    expect(() => rememberSignupAttribution(page, "web")).not.toThrow();
  });
});
