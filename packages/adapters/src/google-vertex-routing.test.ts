import { afterEach, describe, expect, it, vi } from "vitest";
import { buildModelConnectPlaintext } from "./model-connect.js";
import { verifyModelServesAgents } from "./model-connect-check.js";
import { parseModelSecret } from "./model-secret.js";
import { listPiCatalog } from "./pi-models.js";
import { resolveRuntimeModel } from "./pi-runtime-models.js";

const config = {
  provider: "google-vertex",
  id: "gemini-4-hydrogen",
  apiKey: "fake-vertex-api-key",
  projectId: "example-project",
  region: "global",
};

afterEach(() => vi.unstubAllGlobals());

describe("project-scoped model connections", () => {
  it("persists routing on key rotation and edits without a replacement key", () => {
    const saved = buildModelConnectPlaintext(config);
    expect(parseModelSecret(saved)).toMatchObject({
      projectId: config.projectId,
      region: "global",
    });
    const updated = buildModelConnectPlaintext(
      { provider: config.provider, region: "us-central1" },
      saved,
    );
    expect(parseModelSecret(updated)).toMatchObject({
      key: config.apiKey,
      projectId: config.projectId,
      region: "us-central1",
    });
    expect(
      parseModelSecret(
        buildModelConnectPlaintext(
          { provider: config.provider, apiKey: "replacement-fake-key" },
          updated,
        ),
      ),
    ).toMatchObject({ projectId: config.projectId, region: "us-central1" });
  });

  it.each(["../other", "foo/bar", "evil.example?x=1", "", "us-central1.example.com"])(
    "rejects unsafe routing: %s",
    (value) => {
      expect(() => buildModelConnectPlaintext({ ...config, projectId: value })).toThrow(
        "project ID and region",
      );
      expect(() => buildModelConnectPlaintext({ ...config, region: value })).toThrow(
        "project ID and region",
      );
    },
  );

  it.each(["us_central1", "-us-central1", "us-central1-", "Global", "a".repeat(53)])(
    "rejects a region that cannot form a regional hostname: %s",
    (region) => {
      expect(() => buildModelConnectPlaintext({ ...config, region })).toThrow(
        "project ID and region",
      );
      expect(() => resolveRuntimeModel({ ...config, region })).toThrow("project ID and region");
    },
  );

  it("keeps key-only legacy routing and isolates two connections", () => {
    const legacy = resolveRuntimeModel({
      provider: config.provider,
      id: config.id,
      apiKey: config.apiKey,
    });
    const global = resolveRuntimeModel(config);
    const regional = resolveRuntimeModel({
      ...config,
      projectId: "other-project",
      region: "us-central1",
    });
    expect(global.model?.baseUrl).toBe(
      "https://aiplatform.googleapis.com/v1/projects/example-project/locations/global",
    );
    expect(regional.model?.baseUrl).toBe(
      "https://us-central1-aiplatform.googleapis.com/v1/projects/other-project/locations/us-central1",
    );
    expect(legacy.model?.baseUrl).not.toContain("example-project");
    expect(resolveRuntimeModel(config).model?.baseUrl).toBe(global.model?.baseUrl);
  });

  it("offers Hydrogen with supported reasoning levels and routing fields", () => {
    for (const provider of ["google", "google-vertex"]) {
      const entry = listPiCatalog().find(
        (model) => model.provider === provider && model.id === config.id,
      );
      expect(resolveRuntimeModel({ ...config, provider }).model).toMatchObject({
        contextWindow: 1_048_576,
        maxTokens: 65_536,
      });
      expect(entry?.thinkingLevels).toEqual(
        expect.arrayContaining(["low", "medium", "high", "xhigh"]),
      );
      expect(entry?.thinkingLevels).not.toContain("minimal");
      if (provider === config.provider)
        expect(entry?.routingFields).toEqual(["projectId", "region"]);
    }
  });

  it("the actual SDK connection check sends the key to the project/global streaming route", async () => {
    const fetch = vi.fn(
      async () =>
        new Response(
          'data: {"candidates":[{"content":{"role":"model","parts":[{"text":"OK"}]},"finishReason":"STOP"}]}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
    vi.stubGlobal("fetch", fetch);
    await verifyModelServesAgents(config);
    expect(fetch).toHaveBeenCalled();
    const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe(
      "https://aiplatform.googleapis.com/v1/projects/example-project/locations/global/publishers/google/models/gemini-4-hydrogen:streamGenerateContent?alt=sse",
    );
    expect(new Headers(options.headers).get("x-goog-api-key")).toBe(config.apiKey);
    expect(JSON.parse(String(options.body)).tools).toBeDefined();
  });
});
