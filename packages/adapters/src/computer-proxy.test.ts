import { describe, expect, it } from "vitest";
import {
  COMPUTER_PROXY_CONFIG_ENV,
  computerProxyFromEnv,
  computerProxyPrepareEnv,
  PREPARE_COMPUTER_PROXY,
  tinyproxyConfig,
} from "./computer-proxy.js";

describe("computerProxyFromEnv", () => {
  it("is off when unset or blank", () => {
    expect(computerProxyFromEnv({})).toBeUndefined();
    expect(computerProxyFromEnv({ RAKAZO_COMPUTER_PROXY: "  " })).toBeUndefined();
  });

  it("reads an authenticated HTTP proxy and decodes its credentials", () => {
    expect(
      computerProxyFromEnv({
        RAKAZO_COMPUTER_PROXY: "http://us%2Der:p%21ss@proxy.example.com:8080",
      }),
    ).toEqual({
      type: "http",
      host: "proxy.example.com",
      port: 8080,
      username: "us-er",
      password: "p!ss",
    });
  });

  it("reads SOCKS5 with its default port", () => {
    expect(computerProxyFromEnv({ RAKAZO_COMPUTER_PROXY: "socks5://u:p@10.0.0.1" })).toEqual({
      type: "socks5",
      host: "10.0.0.1",
      port: 1080,
      username: "u",
      password: "p",
    });
  });

  it("rejects unsupported schemes and malformed values", () => {
    expect(() => computerProxyFromEnv({ RAKAZO_COMPUTER_PROXY: "https://h:1" })).toThrow(
      /must start with/,
    );
    expect(() => computerProxyFromEnv({ RAKAZO_COMPUTER_PROXY: "not a url" })).toThrow(
      /not a valid URL/,
    );
  });

  it("rejects credentials tinyproxy would split", () => {
    expect(() => computerProxyFromEnv({ RAKAZO_COMPUTER_PROXY: "http://user:p%40ss@h:1" })).toThrow(
      /cannot contain/,
    );
  });
});

describe("tinyproxyConfig", () => {
  it("listens on loopback and forwards with the credentials", () => {
    const config = tinyproxyConfig({
      type: "socks5",
      host: "proxy.example.com",
      port: 1080,
      username: "u",
      password: "p",
    });
    expect(config).toContain("Listen 127.0.0.1\n");
    expect(config).toContain("Allow 127.0.0.1\n");
    expect(config).toContain("Upstream socks5 u:p@proxy.example.com:1080\n");
  });

  it("brackets IPv6 hosts and omits missing credentials", () => {
    expect(tinyproxyConfig({ type: "http", host: "2001:db8::1", port: 3128 })).toContain(
      "Upstream http [2001:db8::1]:3128\n",
    );
  });
});

describe("computerProxyPrepareEnv", () => {
  it("is empty without a proxy", () => {
    expect(computerProxyPrepareEnv({})).toEqual({});
  });

  it("carries the config base64-encoded so the command line never holds credentials", () => {
    const env = computerProxyPrepareEnv({ RAKAZO_COMPUTER_PROXY: "http://u:secret@h:8080" });
    const encoded = env[COMPUTER_PROXY_CONFIG_ENV] ?? "";
    expect(encoded).not.toContain("secret");
    expect(Buffer.from(encoded, "base64").toString()).toContain("Upstream http u:secret@h:8080");
    expect(PREPARE_COMPUTER_PROXY).not.toContain("secret");
  });
});
