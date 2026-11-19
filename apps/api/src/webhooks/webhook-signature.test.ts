import { createHmac } from "node:crypto";
import type { WebhookSignature } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  verifyWebhookSignature,
  WEBHOOK_SIGNATURE_TOLERANCE_SECONDS,
  webhookSigningKey,
} from "./webhook-signature.js";

const NOW = 1_700_000_000;
const BODY = '{"event":"order.paid","id":"evt_fake_1"}';
const FAKE_SECRET = "fake-signing-secret-for-tests";

function headers(values: Record<string, string>) {
  const lower = Object.fromEntries(Object.entries(values).map(([k, v]) => [k.toLowerCase(), v]));
  return (name: string) => lower[name.toLowerCase()];
}

function hmac(
  algorithm: string,
  key: string | Buffer,
  message: string,
  encoding: "hex" | "base64",
) {
  return createHmac(algorithm, key).update(message).digest(encoding);
}

describe("Standard Webhooks signatures", () => {
  const scheme: WebhookSignature = { scheme: "standard-webhooks" };
  // The spec's published test vector, split so it never reads as a saved secret.
  const vector = {
    secret: `whsec_${"MfKQ9r8GKYqrTwjU"}${"PD8ILPZIo2LaLaSw"}`,
    id: "msg_p5jXN8AQM9LWM0D4loKWxJek",
    timestamp: 1614265330,
    body: '{"test": 2432232314}',
    signature: "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=",
  };
  const vectorHeaders = (overrides: Record<string, string> = {}) =>
    headers({
      "webhook-id": vector.id,
      "webhook-timestamp": String(vector.timestamp),
      "webhook-signature": vector.signature,
      ...overrides,
    });
  const verify = (
    h: (name: string) => string | undefined,
    body = vector.body,
    now = vector.timestamp,
  ) => verifyWebhookSignature(scheme, vector.secret, h, body, now);

  it("accepts the spec's test vector and returns its signed id and timestamp", () => {
    expect(verify(vectorHeaders())).toEqual({ id: vector.id, timestamp: String(vector.timestamp) });
  });

  it("accepts the secret without its whsec_ prefix", () => {
    expect(
      verifyWebhookSignature(
        scheme,
        vector.secret.slice("whsec_".length),
        vectorHeaders(),
        vector.body,
        vector.timestamp,
      ),
    ).toEqual({ id: vector.id, timestamp: String(vector.timestamp) });
  });

  it("accepts the alias header names", () => {
    const aliased = headers({
      "svix-id": vector.id,
      "svix-timestamp": String(vector.timestamp),
      "svix-signature": vector.signature,
    });
    expect(verify(aliased)).toEqual({ id: vector.id, timestamp: String(vector.timestamp) });
  });

  it("accepts any listed v1 signature, as during the sender's key rotation", () => {
    const rotating = vectorHeaders({
      "webhook-signature": `v1,${Buffer.alloc(32).toString("base64")} v1a,ignored ${vector.signature}`,
    });
    expect(verify(rotating)).toEqual({ id: vector.id, timestamp: String(vector.timestamp) });
  });

  it("rejects a wrong secret, a tampered body, id or timestamp", () => {
    const otherSecret = `whsec_${Buffer.from("another-fake-key-24-bytes").toString("base64")}`;
    expect(
      verifyWebhookSignature(scheme, otherSecret, vectorHeaders(), vector.body, vector.timestamp),
    ).toBeNull();
    expect(verify(vectorHeaders(), `${vector.body} `)).toBeNull();
    expect(verify(vectorHeaders({ "webhook-id": "msg_other" }))).toBeNull();
    const shifted = String(vector.timestamp + 1);
    expect(verify(vectorHeaders({ "webhook-timestamp": shifted }))).toBeNull();
  });

  it.each([
    ["old", -(WEBHOOK_SIGNATURE_TOLERANCE_SECONDS + 1)],
    ["future", WEBHOOK_SIGNATURE_TOLERANCE_SECONDS + 1],
  ])("rejects a timestamp too far in the %s", (_label, offset) => {
    expect(verify(vectorHeaders(), vector.body, vector.timestamp - offset)).toBeNull();
    expect(
      verify(vectorHeaders(), vector.body, vector.timestamp - Math.sign(offset) * 300),
    ).not.toBeNull();
  });

  it.each([
    ["no id", { "webhook-id": "" }],
    ["no timestamp", { "webhook-timestamp": "" }],
    ["no signature", { "webhook-signature": "" }],
    ["a non-numeric timestamp", { "webhook-timestamp": "1614265330.5" }],
    ["an unversioned signature", { "webhook-signature": vector.signature.slice(3) }],
    ["a signature that is not base64", { "webhook-signature": "v1,not base64!" }],
  ])("rejects %s without throwing", (_label, overrides) => {
    expect(verify(vectorHeaders(overrides))).toBeNull();
  });

  it("refuses a secret that is not base64", () => {
    expect(webhookSigningKey("standard-webhooks", "whsec_not base64!")).toBeNull();
    expect(webhookSigningKey("standard-webhooks", "whsec_")).toBeNull();
    expect(webhookSigningKey("standard-webhooks", vector.secret)).toHaveLength(24);
  });
});

describe("HMAC body signatures", () => {
  const prefixed: WebhookSignature = {
    scheme: "hmac",
    header: "x-hub-signature-256",
    algorithm: "sha256",
    encoding: "hex",
    prefix: "sha256=",
  };

  it("accepts a prefixed hex HMAC of the exact body, which signs nothing else", () => {
    const value = `sha256=${hmac("sha256", FAKE_SECRET, BODY, "hex")}`;
    const h = headers({ "X-Hub-Signature-256": value });
    expect(verifyWebhookSignature(prefixed, FAKE_SECRET, h, BODY, NOW)).toEqual({});
    expect(verifyWebhookSignature(prefixed, FAKE_SECRET, h, `${BODY}\n`, NOW)).toBeNull();
    expect(verifyWebhookSignature(prefixed, "wrong-secret", h, BODY, NOW)).toBeNull();
  });

  it("compares hex case-insensitively and needs the configured prefix", () => {
    const digest = hmac("sha256", FAKE_SECRET, BODY, "hex");
    const upper = headers({ "x-hub-signature-256": `sha256=${digest.toUpperCase()}` });
    expect(verifyWebhookSignature(prefixed, FAKE_SECRET, upper, BODY, NOW)).not.toBeNull();
    const bare = headers({ "x-hub-signature-256": digest });
    expect(verifyWebhookSignature(prefixed, FAKE_SECRET, bare, BODY, NOW)).toBeNull();
  });

  it.each([
    ["sha256", "base64"],
    ["sha512", "hex"],
    ["sha1", "hex"],
  ] as const)("accepts %s in %s without a prefix", (algorithm, encoding) => {
    const signature: WebhookSignature = {
      scheme: "hmac",
      header: "x-signature",
      algorithm,
      encoding,
      prefix: "",
    };
    const h = headers({ "x-signature": hmac(algorithm, FAKE_SECRET, BODY, encoding) });
    expect(verifyWebhookSignature(signature, FAKE_SECRET, h, BODY, NOW)).not.toBeNull();
    // A digest of another algorithm never matches, even when the encoding parses.
    const other = algorithm === "sha512" ? "sha256" : "sha512";
    const wrong = headers({ "x-signature": hmac(other, FAKE_SECRET, BODY, encoding) });
    expect(verifyWebhookSignature(signature, FAKE_SECRET, wrong, BODY, NOW)).toBeNull();
  });

  it.each([undefined, "", "sha256=", "sha256=zz", `sha256=${"a".repeat(63)}`])(
    "rejects a missing or malformed signature without throwing: %s",
    (value) => {
      const h = headers(value === undefined ? {} : { "x-hub-signature-256": value });
      expect(verifyWebhookSignature(prefixed, FAKE_SECRET, h, BODY, NOW)).toBeNull();
    },
  );
});

describe("timestamp-v1 signatures", () => {
  const scheme: WebhookSignature = { scheme: "timestamp-v1", header: "x-event-signature" };
  const sign = (timestamp: number, secret = FAKE_SECRET) =>
    hmac("sha256", secret, `${timestamp}.${BODY}`, "hex");

  it("accepts t=…,v1=… over the timestamp and body, with the secret used as text", () => {
    // A whsec_-looking secret is not decoded here, unlike Standard Webhooks.
    const secret = "whsec_fake-text-secret";
    const h = headers({ "x-event-signature": `t=${NOW},v1=${sign(NOW, secret)}` });
    expect(verifyWebhookSignature(scheme, secret, h, BODY, NOW)).toEqual({
      timestamp: String(NOW),
    });
  });

  it("accepts any listed v1 signature and ignores other versions", () => {
    const h = headers({
      "x-event-signature": `t=${NOW}, v0=${"0".repeat(64)}, v1=${"1".repeat(64)}, v1=${sign(NOW)}`,
    });
    expect(verifyWebhookSignature(scheme, FAKE_SECRET, h, BODY, NOW)).not.toBeNull();
  });

  it.each([
    ["a wrong secret", `t=${NOW},v1=${sign(NOW, "wrong")}`, NOW],
    ["a swapped timestamp", `t=${NOW + 1},v1=${sign(NOW)}`, NOW],
    [
      "an expired timestamp",
      `t=${NOW},v1=${sign(NOW)}`,
      NOW + WEBHOOK_SIGNATURE_TOLERANCE_SECONDS + 1,
    ],
    [
      "a future timestamp",
      `t=${NOW},v1=${sign(NOW)}`,
      NOW - WEBHOOK_SIGNATURE_TOLERANCE_SECONDS - 1,
    ],
    ["no timestamp", `v1=${sign(NOW)}`, NOW],
    ["two timestamps", `t=${NOW},t=${NOW},v1=${sign(NOW)}`, NOW],
    ["no v1 signature", `t=${NOW},v0=${sign(NOW)}`, NOW],
    ["an empty header", "", NOW],
  ])("rejects %s", (_label, value, now) => {
    const h = headers({ "x-event-signature": value });
    expect(verifyWebhookSignature(scheme, FAKE_SECRET, h, BODY, now)).toBeNull();
  });

  it("rejects a tampered body", () => {
    const h = headers({ "x-event-signature": `t=${NOW},v1=${sign(NOW)}` });
    expect(verifyWebhookSignature(scheme, FAKE_SECRET, h, `${BODY} `, NOW)).toBeNull();
  });
});

describe("timestamp-v0 signatures", () => {
  const scheme: WebhookSignature = {
    scheme: "timestamp-v0",
    header: "x-request-signature",
    timestampHeader: "x-request-timestamp",
  };
  const sign = (timestamp: number, body = BODY) =>
    `v0=${hmac("sha256", FAKE_SECRET, `v0:${timestamp}:${body}`, "hex")}`;

  it("accepts v0= over v0:timestamp:body with the timestamp header", () => {
    const h = headers({ "x-request-signature": sign(NOW), "x-request-timestamp": String(NOW) });
    expect(verifyWebhookSignature(scheme, FAKE_SECRET, h, BODY, NOW)).toEqual({
      timestamp: String(NOW),
    });
  });

  it.each([
    ["a missing timestamp", { "x-request-signature": sign(NOW) }, NOW],
    ["a missing signature", { "x-request-timestamp": String(NOW) }, NOW],
    [
      "a swapped timestamp",
      { "x-request-signature": sign(NOW), "x-request-timestamp": String(NOW + 1) },
      NOW,
    ],
    [
      "an expired timestamp",
      { "x-request-signature": sign(NOW), "x-request-timestamp": String(NOW) },
      NOW + WEBHOOK_SIGNATURE_TOLERANCE_SECONDS + 1,
    ],
    [
      "an unversioned signature",
      { "x-request-signature": sign(NOW).slice(3), "x-request-timestamp": String(NOW) },
      NOW,
    ],
    [
      "a tampered body",
      { "x-request-signature": sign(NOW, "{}"), "x-request-timestamp": String(NOW) },
      NOW,
    ],
  ])("rejects %s", (_label, values, now) => {
    expect(verifyWebhookSignature(scheme, FAKE_SECRET, headers(values), BODY, now)).toBeNull();
  });
});
