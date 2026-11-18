import { describe, expect, it } from "vitest";
import {
  hostMatchesProxyConnectPatterns,
  parseProxyConnectHostPatterns,
} from "./proxy-connect-hosts.js";

describe("parseProxyConnectHostPatterns", () => {
  it("lists nothing when unset or blank", () => {
    expect(parseProxyConnectHostPatterns(undefined)).toEqual([]);
    expect(parseProxyConnectHostPatterns("")).toEqual([]);
    expect(parseProxyConnectHostPatterns("  ,  ")).toEqual([]);
  });

  it("keeps exact hosts and subdomain wildcards", () => {
    expect(parseProxyConnectHostPatterns(" API.Example.com , *.cdn.example.org. ")).toEqual([
      { wildcard: false, hostname: "api.example.com" },
      { wildcard: true, hostname: "cdn.example.org" },
    ]);
  });

  it("rejects a bare wildcard", () => {
    expect(() => parseProxyConnectHostPatterns("*")).toThrow(/rejects "\*"/);
    expect(() => parseProxyConnectHostPatterns("api.example.com, *")).toThrow(/rejects "\*"/);
  });

  it.each(["*.com", "*.co.uk", "*.github.io", "com", "co.uk"])(
    "rejects the public suffix %s",
    (pattern) => {
      expect(() => parseProxyConnectHostPatterns(pattern)).toThrow(/public suffix/);
    },
  );

  it.each(["*.*.example.com", "*example.com", ".example.com", "203.0.113.10", "[2001:db8::1]"])(
    "rejects the invalid pattern %s",
    (pattern) => {
      expect(() => parseProxyConnectHostPatterns(pattern)).toThrow(/invalid host pattern/);
    },
  );
});

describe("hostMatchesProxyConnectPatterns", () => {
  const patterns = parseProxyConnectHostPatterns("api.example.com, *.cdn.example.org");

  it("matches a listed host and only the subdomains of a wildcard", () => {
    expect(hostMatchesProxyConnectPatterns("api.example.com", patterns)).toBe(true);
    expect(hostMatchesProxyConnectPatterns("API.Example.com.", patterns)).toBe(true);
    expect(hostMatchesProxyConnectPatterns("files.cdn.example.org", patterns)).toBe(true);
    expect(hostMatchesProxyConnectPatterns("a.b.cdn.example.org", patterns)).toBe(true);
  });

  it("matches a listed internationalized host by its punycode form", () => {
    const idn = parseProxyConnectHostPatterns("münich.example.com");
    expect(hostMatchesProxyConnectPatterns("xn--mnich-kva.example.com", idn)).toBe(true);
    expect(hostMatchesProxyConnectPatterns("münich.example.com", idn)).toBe(false);
  });

  it("does not match the apex of a wildcard or an unlisted host", () => {
    expect(hostMatchesProxyConnectPatterns("cdn.example.org", patterns)).toBe(false);
    expect(hostMatchesProxyConnectPatterns("other.example.com", patterns)).toBe(false);
    expect(hostMatchesProxyConnectPatterns("example.com", [])).toBe(false);
  });
});
