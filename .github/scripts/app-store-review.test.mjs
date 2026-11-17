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

function fakeAppStore({
  buildStates = ["VALID"],
  existingVersion,
  draftItems,
  selectedBuildId = "build-7",
  extraEmptyDraft = false,
} = {}) {
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
    if (path === "/v1/appStoreVersions/version-old/build") return { data: { id: selectedBuildId } };
    if (path === "/v1/apps/app-1/reviewSubmissions")
      return {
        data:
          draftItems === undefined
            ? []
            : [
                ...(extraEmptyDraft
                  ? [
                      {
                        id: "sub-empty",
                        attributes: { platform: "IOS", state: "READY_FOR_REVIEW" },
                      },
                    ]
                  : []),
                {
                  id: "sub-existing",
                  attributes: { platform: "IOS", state: "READY_FOR_REVIEW" },
                },
              ],
      };
    if (path === "/v1/reviewSubmissions/sub-existing/items?include=appStoreVersion")
      return { data: draftItems };
    if (path === "/v1/reviewSubmissions/sub-empty/items?include=appStoreVersion")
      return { data: [] };
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

test("reuses the empty review draft left by a failed item validation", async () => {
  const store = fakeAppStore({ draftItems: [] });
  await submitForReview(store.request, options);
  assert.ok(!summary(store.calls).includes("POST /v1/reviewSubmissions"));
  const item = store.calls.find(({ path }) => path === "/v1/reviewSubmissionItems");
  assert.equal(item.data.relationships.reviewSubmission.data.id, "sub-existing");
  assert.equal(store.calls.at(-1).path, "/v1/reviewSubmissions/sub-existing");
});

test("does not re-add a version already attached to its pending submission", async () => {
  const store = fakeAppStore({
    extraEmptyDraft: true,
    existingVersion: { id: "version-old", attributes: { appStoreState: "READY_FOR_REVIEW" } },
    draftItems: [
      {
        relationships: { appStoreVersion: { data: { id: "version-old" } } },
      },
    ],
  });
  await submitForReview(store.request, options);
  assert.ok(!summary(store.calls).includes("POST /v1/reviewSubmissions"));
  assert.ok(!summary(store.calls).includes("POST /v1/reviewSubmissionItems"));
  assert.equal(store.calls.at(-1).path, "/v1/reviewSubmissions/sub-existing");
  assert.deepEqual(summary(store.calls), ["PATCH /v1/reviewSubmissions/sub-existing"]);
});

test("leaves a review-ready version with a different build unchanged", async () => {
  const store = fakeAppStore({
    existingVersion: { id: "version-old", attributes: { appStoreState: "READY_FOR_REVIEW" } },
    selectedBuildId: "build-other",
  });
  await assert.rejects(submitForReview(store.request, options), /different build attached/);
  assert.deepEqual(summary(store.calls), []);
});

test("finds the matching draft and its version on later pages", async () => {
  const store = fakeAppStore({
    existingVersion: { id: "version-old", attributes: { appStoreState: "READY_FOR_REVIEW" } },
  });
  const draftPage = "https://api.appstoreconnect.apple.com/v1/apps/app-1/reviewSubmissions?page=2";
  const itemPage =
    "https://api.appstoreconnect.apple.com/v1/reviewSubmissions/sub-later/items?page=2";
  const responses = new Map([
    ["/v1/apps/app-1/reviewSubmissions", { data: [], links: { next: draftPage } }],
    [
      draftPage,
      { data: [{ id: "sub-later", attributes: { platform: "IOS", state: "READY_FOR_REVIEW" } }] },
    ],
    [
      "/v1/reviewSubmissions/sub-later/items?include=appStoreVersion",
      { data: [], links: { next: itemPage } },
    ],
    [itemPage, { data: [{ relationships: { appStoreVersion: { data: { id: "version-old" } } } }] }],
  ]);
  await submitForReview(async (method, path, data) => {
    if (responses.has(path)) {
      store.calls.push({ method, path, data });
      return responses.get(path);
    }
    return store.request(method, path, data);
  }, options);
  assert.deepEqual(summary(store.calls), ["PATCH /v1/reviewSubmissions/sub-later"]);
});

test("does not submit another version's review items", async () => {
  const store = fakeAppStore({
    draftItems: [
      {
        relationships: { appStoreVersion: { data: { id: "unrelated-version" } } },
      },
    ],
  });
  await submitForReview(store.request, options);
  assert.ok(summary(store.calls).includes("POST /v1/reviewSubmissions"));
  assert.equal(store.calls.at(-1).path, "/v1/reviewSubmissions/sub-1");
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

  const associatedRequest = appStoreClient(credentials, async () => ({
    ok: false,
    status: 409,
    text: async () =>
      JSON.stringify({
        errors: [
          {
            detail: "This resource cannot be reviewed",
            meta: {
              associatedErrors: { "version-example": [{ detail: "Copyright is required" }] },
            },
          },
        ],
      }),
  }));
  await assert.rejects(
    associatedRequest("POST", "/v1/reviewSubmissionItems"),
    /This resource cannot be reviewed; Copyright is required/,
  );

  let fetched = false;
  const guardedRequest = appStoreClient(credentials, async () => {
    fetched = true;
  });
  await assert.rejects(guardedRequest("GET", "https://example.invalid/next"), /outside Apple/);
  assert.equal(fetched, false);
});
