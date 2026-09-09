import { describe, expect, it } from "vitest";
import {
  openScreenCapability,
  SCREEN_PROXY_TTL_MS,
  sealScreenCapability,
} from "./screen-capability.js";

const scope = {
  botId: "bot",
  computerId: "computer",
  botGeneration: 2,
  computerGeneration: 3,
  controlLeaseId: null,
};
const path = (url: string, interactive = false) =>
  new URL(
    sealScreenCapability(
      `${url}?token=fake-provider-token&view_only=${!interactive}`,
      "fake-secret",
      "https://app.example",
      scope,
      100,
    ),
  ).pathname;
describe("sealed screen capabilities", () => {
  it("hides provider credentials and binds scope and destination", () => {
    const value = path("https://screen.example/vnc.html");
    expect(value).not.toContain("fake-provider-token");
    expect(openScreenCapability(value, "fake-secret", 101)).toMatchObject({
      scope,
      target: {
        hostname: "screen.example",
        port: 443,
        protocol: "https:",
        interactive: false,
        path: "/vnc.html?token=fake-provider-token&view_only=true",
      },
    });
    expect(
      openScreenCapability(value.replace("/vnc.html", "/websockify"), "fake-secret", 101)?.target
        .path,
    ).toBe("/websockify?token=fake-provider-token&view_only=true");
  });
  it("keeps noVNC routing public and nested provider socket credentials sealed", () => {
    const provider = new URL("https://screen.example/vnc.html");
    provider.searchParams.set("path", "websockify?token=fake-socket-token");
    const url = new URL(
      sealScreenCapability(provider.toString(), "fake-secret", "https://app.example", scope, 100),
    );
    expect(url.toString()).not.toContain("fake-socket-token");
    expect(url.searchParams.get("autoconnect")).toBe("true");
    const socketPath = `/${url.searchParams.get("path")}`;
    expect(openScreenCapability(socketPath, "fake-secret", 101)?.target.path).toBe(
      "/websockify?token=fake-socket-token",
    );
  });

  it("randomizes issuance even at the same timestamp", () => {
    expect(path("http://127.0.0.1:49152/embed.html")).not.toBe(
      path("http://127.0.0.1:49152/embed.html"),
    );
  });
  it("rejects wrong keys, modified policy, expiry and ciphertext", () => {
    const value = path("http://127.0.0.1:49152/embed.html");
    expect(openScreenCapability(value, "wrong", 101)).toBeNull();
    expect(
      openScreenCapability(value.replace("/view/", "/control/"), "fake-secret", 101),
    ).toBeNull();
    expect(
      openScreenCapability(value.replace("3600100.", "3600101."), "fake-secret", 101),
    ).toBeNull();
    expect(
      openScreenCapability(
        value.replace(/\.(.)/, (_, c) => `.${c === "a" ? "b" : "a"}`),
        "fake-secret",
        101,
      ),
    ).toBeNull();
    expect(openScreenCapability(value, "fake-secret", 100 + SCREEN_PROXY_TTL_MS)).toBeNull();
  });
  it("rejects truncated capability tokens before decryption", () => {
    const value = path("http://127.0.0.1:49152/embed.html");
    const match = value.match(/^(\/novnc\/session\/view\/\d+\.)([A-Za-z0-9_-]+)(\/.*)$/);
    expect(match).not.toBeNull();
    const truncated = `${match![1]}${match![2]!.slice(0, 8)}${match![3]}`;
    expect(openScreenCapability(truncated, "fake-secret", 101)).toBeNull();
  });
  it("enforces view policy and still serves relative assets", () => {
    const value = path("http://127.0.0.1:49152/embed.html");
    expect(
      openScreenCapability(`${value}?view_only=false`, "fake-secret", 101)?.target.path,
    ).toContain("view_only=true");
    expect(
      openScreenCapability(value.replace("/embed.html", "/core/rfb.js"), "fake-secret", 101)?.target
        .path,
    ).toBe("/core/rfb.js");
    expect(
      openScreenCapability(path("http://127.0.0.1:49152/embed.html", true), "fake-secret", 101)
        ?.target.interactive,
    ).toBe(true);
  });
  it.each(["http://public.example:49152/embed.html", "http://127.0.0.1:80/embed.html"])(
    "rejects disallowed local target %s",
    (url) => {
      expect(openScreenCapability(path(url), "fake-secret", 101)).toBeNull();
    },
  );
});
