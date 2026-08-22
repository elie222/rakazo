import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import {
  fetchOpenAICompatibleModels,
  GATEWAY_PROVIDER_PREFIX,
  isGatewayProvider,
  labelForDiscoveredModels,
  normalizeOpenAICompatibleBaseUrl,
  parseAvailableModels,
  secretIdForGatewayModel,
  serializeAvailableModels,
  unionAvailableModels,
} from "./openai-compatible.js";

describe("openai-compatible gateways", () => {
  it("normalizes hostnames, trailing slashes, and missing protocols", () => {
    expect(normalizeOpenAICompatibleBaseUrl("localhost:11434/v1")).toBe(
      "http://localhost:11434/v1",
    );
    expect(normalizeOpenAICompatibleBaseUrl("https://api.example.com/v1/")).toBe(
      "https://api.example.com/v1",
    );
  });

  it("rejects non-http URLs", () => {
    expect(() => normalizeOpenAICompatibleBaseUrl("ftp://example.com")).toThrow(/http/);
    expect(() => normalizeOpenAICompatibleBaseUrl("https://user:pass@example.com/v1")).toThrow(
      /credentials/,
    );
  });

  it("blocks private-network model probes unless deployment-owner access is explicit", async () => {
    let requests = 0;
    const server = createServer((_request, response) => {
      requests += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "local-model" }] }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}/v1`;
    try {
      await expect(fetchOpenAICompatibleModels(baseUrl, "fake-probe-key")).rejects.toThrow(
        /deployment-owner/,
      );
      expect(requests).toBe(0);
      await expect(
        fetchOpenAICompatibleModels(baseUrl, "fake-probe-key", undefined, {
          allowPrivateNetwork: true,
        }),
      ).resolves.toEqual(["local-model"]);
      expect(requests).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  });

  it("does not forward an API key across model-discovery origins", async () => {
    let forwardedAuthorization = "";
    const destination = createServer((request, response) => {
      forwardedAuthorization = String(request.headers.authorization ?? "");
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: [{ id: "redirected-model" }] }));
    });
    await new Promise<void>((resolve) => destination.listen(0, "127.0.0.1", resolve));
    const destinationAddress = destination.address();
    const destinationPort =
      typeof destinationAddress === "object" && destinationAddress ? destinationAddress.port : 0;
    const source = createServer((_request, response) => {
      response.writeHead(302, {
        location: `http://127.0.0.1:${destinationPort}/v1/models`,
      });
      response.end();
    });
    await new Promise<void>((resolve) => source.listen(0, "127.0.0.1", resolve));
    const sourceAddress = source.address();
    const sourcePort = typeof sourceAddress === "object" && sourceAddress ? sourceAddress.port : 0;
    try {
      await expect(
        fetchOpenAICompatibleModels(
          `http://127.0.0.1:${sourcePort}/v1`,
          "fake-origin-key",
          undefined,
          { allowPrivateNetwork: true },
        ),
      ).resolves.toEqual(["redirected-model"]);
      expect(forwardedAuthorization).toBe("");
    } finally {
      await Promise.all(
        [source, destination].map(
          (server) =>
            new Promise<void>((resolve, reject) =>
              server.close((error) => (error ? reject(error) : resolve())),
            ),
        ),
      );
    }
  });

  it("round-trips model lists and recognizes gateway provider ids", () => {
    expect(parseAvailableModels("gpt-4o\nllama3, mistral")).toEqual([
      "gpt-4o",
      "llama3",
      "mistral",
    ]);
    expect(serializeAvailableModels(["gpt-4o", "gpt-4o", "llama3"])).toBe("gpt-4o\nllama3");
    expect(isGatewayProvider(`${GATEWAY_PROVIDER_PREFIX}abc`)).toBe(true);
    expect(isGatewayProvider("openai-compatible")).toBe(true);
    expect(isGatewayProvider("openrouter")).toBe(false);
  });

  it("picks the key whose discovered models include the requested model", () => {
    const credential = {
      secretId: "active-secret",
      keys: [
        {
          secretId: "gemini-secret",
          isActive: false,
          availableModels: "gemini-2.5-pro\ngemini-2.5-flash",
        },
        {
          secretId: "active-secret",
          isActive: true,
          availableModels: "gpt-4o\no4-mini",
        },
      ],
    };
    expect(secretIdForGatewayModel(credential, "gemini-2.5-flash")).toBe("gemini-secret");
    expect(secretIdForGatewayModel(credential, "gpt-4o")).toBe("active-secret");
    expect(secretIdForGatewayModel(credential, "unknown-model")).toBe("active-secret");
    expect(secretIdForGatewayModel(credential, undefined)).toBe("active-secret");
    expect(unionAvailableModels(credential.keys)).toEqual([
      "gemini-2.5-pro",
      "gemini-2.5-flash",
      "gpt-4o",
      "o4-mini",
    ]);
    expect(labelForDiscoveredModels(["gemini-2.5-pro", "gemini-2.0-flash"])).toBe("Gemini");
    expect(labelForDiscoveredModels(["gpt-4o", "gpt-4.1"])).toBe("GPT");
    expect(labelForDiscoveredModels(["o4-mini"])).toBe("OpenAI");
    expect(labelForDiscoveredModels(["gemini-2.5-pro", "gpt-4o"])).toBe("API key");
  });
});
