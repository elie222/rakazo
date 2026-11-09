import { createVerify, generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import type { AppleClientSecretInput } from "./apple-client-secret.js";
import {
  APPLE_CLIENT_SECRET_AUDIENCE,
  APPLE_CLIENT_SECRET_LIFETIME_SECONDS,
  APPLE_CLIENT_SECRET_MAX_AGE_SECONDS,
  createAppleClientSecretCache,
  signAppleClientSecret,
} from "./apple-client-secret.js";

const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const input: AppleClientSecretInput = {
  clientId: "com.example.service",
  teamId: "TEAMID1234",
  keyId: "KEYID12345",
  privateKey: pem,
};

it("signs an ES256 client secret under Apple's six-month cap", () => {
  const now = new Date("2026-01-01T00:00:00Z");
  const { token, expiresAt } = signAppleClientSecret(input, now);
  const [encodedHeader, encodedPayload, encodedSignature] = token.split(".");
  expect(encodedHeader && encodedPayload && encodedSignature).toBeTruthy();
  expect(JSON.parse(Buffer.from(encodedHeader!, "base64url").toString())).toEqual({
    alg: "ES256",
    kid: input.keyId,
  });
  const claims = JSON.parse(Buffer.from(encodedPayload!, "base64url").toString()) as {
    iss: string;
    sub: string;
    aud: string;
    iat: number;
    exp: number;
  };
  expect(claims).toMatchObject({
    iss: input.teamId,
    sub: input.clientId,
    aud: APPLE_CLIENT_SECRET_AUDIENCE,
    iat: Math.floor(now.getTime() / 1000),
  });
  expect(claims.exp - claims.iat).toBe(APPLE_CLIENT_SECRET_LIFETIME_SECONDS);
  expect(claims.exp - claims.iat).toBeLessThan(APPLE_CLIENT_SECRET_MAX_AGE_SECONDS);
  expect(expiresAt).toEqual(new Date(claims.exp * 1000));
  const verifier = createVerify("SHA256");
  verifier.update(`${encodedHeader}.${encodedPayload}`);
  verifier.end();
  expect(
    verifier.verify(
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(encodedSignature!, "base64url"),
    ),
  ).toBe(true);
});

it("accepts a private key whose newlines were escaped", () => {
  const escaped = pem.trim().replace(/\n/g, "\\n");
  expect(signAppleClientSecret({ ...input, privateKey: escaped }).token.split(".")).toHaveLength(3);
});

it("refuses a key that cannot sign for Apple", () => {
  expect(() => signAppleClientSecret({ ...input, privateKey: "not a key" })).toThrow(/PKCS#8 PEM/);
  const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey.export({
    type: "pkcs8",
    format: "pem",
  });
  expect(() => signAppleClientSecret({ ...input, privateKey: rsa.toString() })).toThrow(/P-256/);
});

it("keeps a cached secret until the refresh margin, then signs a new one", async () => {
  let now = new Date("2026-01-01T00:00:00Z");
  let signed = 0;
  const cache = createAppleClientSecretCache(input, {
    now: () => now,
    lifetimeSeconds: 1_000,
    refreshMarginSeconds: 100,
    sign: async (_value, at) => {
      signed += 1;
      return { token: `secret-${signed}`, expiresAt: new Date(at.getTime() + 1_000_000) };
    },
  });
  expect(await cache.current()).toBe("secret-1");
  now = new Date(now.getTime() + 800_000);
  expect(await cache.current()).toBe("secret-1");
  expect(signed).toBe(1);
  now = new Date("2026-01-01T00:00:00Z");
  now = new Date(now.getTime() + 900_000);
  expect(await cache.current()).toBe("secret-2");
  expect(signed).toBe(2);
  expect(cache.peek()).toBe("secret-2");
});

it("shares one signature across callers that arrive together", async () => {
  let signed = 0;
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cache = createAppleClientSecretCache(input, {
    refreshMarginSeconds: 10,
    sign: async () => {
      signed += 1;
      await gate;
      return { token: "shared", expiresAt: new Date(Date.now() + 60_000_000) };
    },
  });
  const pending = Promise.all([cache.current(), cache.current()]);
  release();
  await expect(pending).resolves.toEqual(["shared", "shared"]);
  expect(signed).toBe(1);
  expect(await cache.current()).toBe("shared");
  expect(signed).toBe(1);
});
