// Sends an iOS build that EAS uploaded to App Store review: waits until Apple has processed it,
// puts it on the matching App Store version with its release notes, and submits that version.
import { sign } from "node:crypto";
import { pathToFileURL } from "node:url";

const API = "https://api.appstoreconnect.apple.com";
// States in which the version's build and notes can still change before it is submitted.
const EDITABLE = new Set([
  "PREPARE_FOR_SUBMISSION",
  "DEVELOPER_REJECTED",
  "REJECTED",
  "METADATA_REJECTED",
]);

const base64url = (value) => Buffer.from(value).toString("base64url");

function errorDetails(errors) {
  const details = [];
  for (const error of errors) {
    if (error.detail || error.title) details.push(error.detail ?? error.title);
    for (const associated of Object.values(error.meta?.associatedErrors ?? {})) {
      details.push(...errorDetails([associated].flat()));
    }
  }
  return details;
}

export function appStoreToken({ keyId, issuerId, privateKey }, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const header = base64url(JSON.stringify({ alg: "ES256", kid: keyId, typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({ iss: issuerId, iat, exp: iat + 600, aud: "appstoreconnect-v1" }),
  );
  const signature = sign("sha256", Buffer.from(`${header}.${claims}`), {
    key: privateKey,
    dsaEncoding: "ieee-p1363",
  });
  return `${header}.${claims}.${signature.toString("base64url")}`;
}

export function appStoreClient(credentials, fetchImpl = fetch) {
  return async (method, path, data) => {
    const url = new URL(path, API);
    if (url.origin !== API) throw new Error("Refusing an App Store pagination URL outside Apple");
    const response = await fetchImpl(url.href, {
      method,
      headers: {
        Authorization: `Bearer ${appStoreToken(credentials)}`,
        "Content-Type": "application/json",
      },
      body: data === undefined ? undefined : JSON.stringify({ data }),
    });
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const detail = [...new Set(errorDetails(body.errors ?? []))].join("; ");
      throw new Error(`${method} ${path} failed with ${response.status}: ${detail || text}`);
    }
    return body;
  };
}

async function allPages(request, path) {
  const result = [];
  while (path) {
    const page = await request("GET", path);
    result.push(...page.data);
    path = page.links?.next;
  }
  return result;
}

async function processedBuild(request, { appId, version, buildNumber, sleep, timeoutMs }) {
  const query = new URLSearchParams({
    "filter[app]": appId,
    "filter[version]": buildNumber,
    "filter[preReleaseVersion.version]": version,
    "filter[preReleaseVersion.platform]": "IOS",
  });
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const build = (await request("GET", `/v1/builds?${query}`)).data[0];
    const state = build?.attributes.processingState;
    if (state === "VALID") return build;
    if (state === "FAILED" || state === "INVALID")
      throw new Error(`Apple could not process build ${buildNumber}: ${state}`);
    if (Date.now() > deadline)
      throw new Error(`Build ${buildNumber} was not processed in time (${state ?? "not found"})`);
    console.log(
      `Waiting for Apple to process build ${buildNumber} (${state ?? "not uploaded yet"})`,
    );
    await sleep(30_000);
  }
}

export async function submitForReview(request, options) {
  const { appId, version, buildNumber, notes } = options;
  const build = await processedBuild(request, options);
  const buildRef = { data: { type: "builds", id: build.id } };

  const existing = (
    await request(
      "GET",
      `/v1/apps/${appId}/appStoreVersions?filter[platform]=IOS&filter[versionString]=${version}`,
    )
  ).data[0];
  const ready = existing?.attributes.appStoreState === "READY_FOR_REVIEW";
  if (existing && !EDITABLE.has(existing.attributes.appStoreState) && !ready) {
    console.log(`${version} is already ${existing.attributes.appStoreState}; nothing to submit`);
    return;
  }
  let versionId = existing?.id;
  if (ready) {
    const selected = await request("GET", `/v1/appStoreVersions/${versionId}/build`);
    if (selected.data?.id !== build.id)
      throw new Error(
        "The review-ready version has a different build attached; leave it unchanged",
      );
  } else if (versionId) {
    await request("PATCH", `/v1/appStoreVersions/${versionId}`, {
      type: "appStoreVersions",
      id: versionId,
      attributes: { releaseType: "AFTER_APPROVAL" },
      relationships: { build: buildRef },
    });
  } else {
    const created = await request("POST", "/v1/appStoreVersions", {
      type: "appStoreVersions",
      attributes: { platform: "IOS", versionString: version, releaseType: "AFTER_APPROVAL" },
      relationships: { app: { data: { type: "apps", id: appId } }, build: buildRef },
    });
    versionId = created.data.id;
  }

  if (!ready) {
    const localizations = await request(
      "GET",
      `/v1/appStoreVersions/${versionId}/appStoreVersionLocalizations`,
    );
    for (const localization of localizations.data) {
      await request("PATCH", `/v1/appStoreVersionLocalizations/${localization.id}`, {
        type: "appStoreVersionLocalizations",
        id: localization.id,
        attributes: { whatsNew: notes },
      });
    }
  }

  const drafts = await allPages(request, `/v1/apps/${appId}/reviewSubmissions`);
  let submission;
  let emptyDraft;
  let attached = false;
  for (const draft of drafts) {
    if (draft.attributes.platform !== "IOS" || draft.attributes.state !== "READY_FOR_REVIEW")
      continue;
    const items = await allPages(
      request,
      `/v1/reviewSubmissions/${draft.id}/items?include=appStoreVersion`,
    );
    if (items.length === 0) {
      emptyDraft ??= draft;
      continue;
    }
    if (items.length === 1 && items[0].relationships?.appStoreVersion?.data?.id === versionId) {
      submission = { data: draft };
      attached = true;
      break;
    }
  }
  if (!submission && emptyDraft) submission = { data: emptyDraft };
  submission ??= await request("POST", "/v1/reviewSubmissions", {
    type: "reviewSubmissions",
    attributes: { platform: "IOS" },
    relationships: { app: { data: { type: "apps", id: appId } } },
  });
  if (!attached)
    await request("POST", "/v1/reviewSubmissionItems", {
      type: "reviewSubmissionItems",
      relationships: {
        reviewSubmission: { data: { type: "reviewSubmissions", id: submission.data.id } },
        appStoreVersion: { data: { type: "appStoreVersions", id: versionId } },
      },
    });
  await request("PATCH", `/v1/reviewSubmissions/${submission.data.id}`, {
    type: "reviewSubmissions",
    id: submission.data.id,
    attributes: { submitted: true },
  });
  console.log(`Submitted ${version} (${buildNumber}) for App Store review`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const env = (name) => {
    const value = process.env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const request = appStoreClient({
    keyId: env("ASC_KEY_ID"),
    issuerId: env("ASC_ISSUER_ID"),
    privateKey: env("ASC_PRIVATE_KEY"),
  });
  await submitForReview(request, {
    appId: env("ASC_APP_ID"),
    version: env("APP_VERSION"),
    buildNumber: env("BUILD_NUMBER"),
    notes: env("RELEASE_NOTES"),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    timeoutMs: 60 * 60_000,
  });
}
