import assert from "node:assert/strict";
import { generateKeyPairSync, verify } from "node:crypto";
import { test } from "node:test";
import { appStoreClient, appStoreToken, submitForReview } from "./app-store-review.mjs";

const options = {
  appId: "app-1",
  version: "2.0.0",
  buildNumber: "7",
  notes: "Example notes.",
  sleep: async () => {},
  timeoutMs: 60_000,
};

function fakeAppStore({ buildStates = ["VALID"], existingVersion } = {}) {
  const calls = [];
  const request = async (method, path, data) => {
    calls.push({ method, path, data });
    if (path.startsWith("/v1/builds?")) {
      const state = buildStates.length > 1 ? buildStates.shift() : buildStates[0];
      return { data: state ? [{ id: "build-7", attributes: { processingState: state } }] : [] };
    }
    if (path.startsWith("/v1/apps/app-1/appStoreVersions"))
      return { data: existingVersion ? [existingVersion] : [] };
    if (method === "POST" && path === "/v1/appStoreVersions")
      return { data: { id: "version-new" } };
    if (path.endsWith("/appStoreVersionLocalizations"))
      return { data: [{ id: "loc-en" }, { id: "loc-de" }] };
    if (method === "POST" && path === "/v1/reviewSubmissions") return { data: { id: "sub-1" } };
    return { data: {} };
  };
  return { calls, request };
}

const summary = (calls) =>
  calls.filter(({ method }) => method !== "GET").map(({ method, path }) => `${method} ${path}`);

test("waits for processing, then creates the version with notes and submits it", async () => {
  const store = fakeAppStore({ buildStates: [undefined, "PROCESSING", "VALID"] });
  await submitForReview(store.request, options);
  assert.equal(store.calls.filter(({ path }) => path.startsWith("/v1/builds?")).length, 3);
  assert.deepEqual(summary(store.calls), [
    "POST /v1/appStoreVersions",
    "PATCH /v1/appStoreVersionLocalizations/loc-en",
    "PATCH /v1/appStoreVersionLocalizations/loc-de",
    "POST /v1/reviewSubmissions",
    "POST /v1/reviewSubmissionItems",
    "PATCH /v1/reviewSubmissions/sub-1",
  ]);
  const created = store.calls.find(({ path }) => path === "/v1/appStoreVersions").data;
  assert.equal(created.attributes.versionString, "2.0.0");
  assert.equal(created.relationships.build.data.id, "build-7");
  const notes = store.calls.find(({ path }) => path.endsWith("/loc-en")).data;
  assert.equal(notes.attributes.whatsNew, "Example notes.");
  const submitted = store.calls.at(-1).data;
  assert.equal(submitted.attributes.submitted, true);
});

test("puts the build on a version still being prepared and releases it on approval", async () => {
  const store = fakeAppStore({
    existingVersion: { id: "version-old", attributes: { appStoreState: "PREPARE_FOR_SUBMISSION" } },
  });
  await submitForReview(store.request, options);
  const updated = store.calls.find(({ method }) => method !== "GET");
  assert.equal(updated.path, "/v1/appStoreVersions/version-old");
  assert.equal(updated.data.attributes.releaseType, "AFTER_APPROVAL");
  assert.equal(updated.data.relationships.build.data.id, "build-7");
  assert.equal(store.calls.at(-1).path, "/v1/reviewSubmissions/sub-1");
});

test("leaves a version that is already in review alone", async () => {
  const store = fakeAppStore({
    existingVersion: { id: "version-old", attributes: { appStoreState: "WAITING_FOR_REVIEW" } },
  });
  await submitForReview(store.request, options);
  assert.deepEqual(summary(store.calls), []);
});

test("stops when Apple rejects the build", async () => {
  const store = fakeAppStore({ buildStates: ["INVALID"] });
  await assert.rejects(submitForReview(store.request, options), /could not process build 7/);
});

test("stops when the build never finishes processing", async () => {
  const store = fakeAppStore({ buildStates: ["PROCESSING"] });
  await assert.rejects(
    submitForReview(store.request, { ...options, timeoutMs: -1 }),
    /not processed in time/,
  );
});

test("signs requests with an ES256 token Apple can verify", async () => {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const credentials = {
    keyId: "KEY123",
    issuerId: "issuer-example",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }),
  };
  const [header, claims, signature] = appStoreToken(credentials, 1_000_000).split(".");
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url")), {
    alg: "ES256",
    kid: "KEY123",
    typ: "JWT",
  });
  assert.deepEqual(JSON.parse(Buffer.from(claims, "base64url")), {
    iss: "issuer-example",
    iat: 1000,
    exp: 1600,
    aud: "appstoreconnect-v1",
  });
  assert.ok(
    verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      { key: publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature, "base64url"),
    ),
  );

  const request = appStoreClient(credentials, async () => ({
    ok: false,
    status: 409,
    text: async () => JSON.stringify({ errors: [{ detail: "Another version is editable" }] }),
  }));
  await assert.rejects(request("GET", "/v1/apps"), /409: Another version is editable/);
});
