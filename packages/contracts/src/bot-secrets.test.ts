import { describe, expect, it } from "vitest";
import {
  BotSecretDestination,
  botSecretDestinationSchema,
  decodeLoginSecret,
  encodeLoginSecret,
  isCloudMetadataHost,
  isPrivateNetworkHost,
  SecretHttpRequest,
} from "./bot-secrets.js";

const destination = {
  name: "example_api",
  origin: "https://api.example.test",
  auth: { type: "bearer" },
};

describe("credential contracts", () => {
  it.each([
    "http://api.example.test",
    "https://user:pass@api.example.test",
    "https://api.example.test/path",
    "https://api.example.test?query=1",
    "https://api.example.test#fragment",
  ])("rejects non-origin destination %s", (origin) => {
    expect(BotSecretDestination.safeParse({ ...destination, origin }).success).toBe(false);
  });
  it.each(["feishu-app-credentials", "my-creds-2", "team_a-bot"])(
    "accepts hyphenated credential names like %s",
    (name) => {
      expect(BotSecretDestination.safeParse({ ...destination, name }).success).toBe(true);
    },
  );
  it.each(["Feishu App", "-leading", "with space", ""])(
    "rejects malformed credential names %s",
    (name) => {
      expect(BotSecretDestination.safeParse({ ...destination, name }).success).toBe(false);
    },
  );
  it.each([
    "Host",
    "Connection",
    "Content-Length",
    "Cookie",
    "Proxy-Authorization",
    "X-Forwarded-Host",
    "Sec-Fetch-Site",
    "X-Key\r\nHost",
  ])("rejects reserved or malformed header %s", (name) => {
    expect(
      BotSecretDestination.safeParse({ ...destination, auth: { type: "header", name } }).success,
    ).toBe(false);
  });
  it.each(["GET", "HEAD"])("rejects even an empty body on %s", (method) => {
    expect(
      SecretHttpRequest.safeParse({
        name: "example_api",
        url: destination.origin,
        method,
        body: "",
      }).success,
    ).toBe(false);
  });
  it("accepts ordinary authentication and bounds request inputs", () => {
    expect(BotSecretDestination.parse(destination)).toEqual(destination);
    expect(
      BotSecretDestination.safeParse({
        ...destination,
        auth: { type: "header", name: "X-Api-Key" },
      }).success,
    ).toBe(true);
    expect(
      SecretHttpRequest.safeParse({ name: "example_api", url: destination.origin, body: "body" })
        .success,
    ).toBe(false);
    expect(
      SecretHttpRequest.safeParse({
        name: "example_api",
        url: destination.origin,
        method: "POST",
        body: "x".repeat(100_001),
      }).success,
    ).toBe(false);
  });
});

describe("private HTTP credential origins", () => {
  const relaxed = botSecretDestinationSchema({ allowPrivateHttpOrigin: true });

  it("rejects private HTTP origins by default", () => {
    expect(
      BotSecretDestination.safeParse({ ...destination, origin: "http://192.168.2.10:8080" })
        .success,
    ).toBe(false);
  });
  it.each([
    "http://192.168.2.10:8080",
    "http://10.1.2.3",
    "http://172.16.5.4",
    "http://172.31.255.254",
    "http://100.100.1.5",
    "http://localhost:3000",
    "http://nas.local",
  ])("accepts private HTTP origin %s when the owner opts in", (origin) => {
    expect(relaxed.safeParse({ ...destination, origin }).success).toBe(true);
  });
  it("still rejects public HTTP origins when the owner opts in", () => {
    expect(relaxed.safeParse({ ...destination, origin: "http://api.example.test" }).success).toBe(
      false,
    );
  });
  it("rejects a private HTTP origin for a website login even when the owner opts in", () => {
    expect(
      relaxed.safeParse({
        ...destination,
        origin: "http://192.168.2.10:8080",
        auth: { type: "login" },
      }).success,
    ).toBe(false);
    expect(relaxed.safeParse({ ...destination, auth: { type: "login" } }).success).toBe(true);
  });
  it.each([
    "http://192.168.2.10:8080/upload",
    "http://192.168.2.10:8080?key=1",
    "http://100.100.100.200",
    "http://169.254.170.2",
    "http://169.254.169.254",
  ])("relaxed schema still rejects non-origin URLs %s", (origin) => {
    expect(relaxed.safeParse({ ...destination, origin }).success).toBe(false);
  });
  it.each(["100.100.100.200", "169.254.170.2", "169.254.169.254", "metadata.google.internal"])(
    "classifies metadata host %s",
    (host) => {
      expect(isCloudMetadataHost(host)).toBe(true);
    },
  );
  it.each([
    ["100.63.0.1", false],
    ["100.64.0.1", true],
    ["100.127.255.254", true],
    ["100.128.0.1", false],
    ["172.15.0.1", false],
    ["172.16.0.1", true],
    ["172.32.0.1", false],
    ["192.169.0.1", false],
    ["example.test", false],
  ])("classifies private host %s", (host, expected) => {
    expect(isPrivateNetworkHost(host)).toBe(expected);
  });
});

describe("login credentials", () => {
  it("accepts a login destination and round-trips its value", () => {
    expect(
      BotSecretDestination.safeParse({ ...destination, auth: { type: "login" } }).success,
    ).toBe(true);
    const value = { username: "fake-user", password: "fake:password\nwith newline" };
    expect(decodeLoginSecret(encodeLoginSecret(value))).toEqual(value);
  });

  it.each([
    { username: "", password: "fake-password" },
    { username: "fake-user", password: "" },
  ])("rejects an incomplete login %j", (value) => {
    expect(() => encodeLoginSecret(value)).toThrow();
  });
});
