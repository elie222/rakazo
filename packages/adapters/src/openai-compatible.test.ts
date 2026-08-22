import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertOpenAICompatibleBaseUrlAllowed,
  createOpenAICompatibleFetch,
  fetchOpenAICompatibleModels,
  GATEWAY_PROVIDER_PREFIX,
  isGatewayProvider,
  isGloballyRoutableAddress,
  normalizeOpenAICompatibleBaseUrl,
  parseAvailableModels,
  serializeAvailableModels,
} from "./openai-compatible.js";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );
});

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
    expect(() => normalizeOpenAICompatibleBaseUrl("http://user:pass@example.com/v1")).toThrow(
      /credentials/,
    );
  });

  it("classifies private, metadata, documentation, and public addresses", () => {
    expect(isGloballyRoutableAddress("127.0.0.1")).toBe(false);
    expect(isGloballyRoutableAddress("169.254.169.254")).toBe(false);
    expect(isGloballyRoutableAddress("203.0.113.4")).toBe(false);
    expect(isGloballyRoutableAddress("8.8.8.8")).toBe(true);
    expect(isGloballyRoutableAddress("::1")).toBe(false);
    expect(isGloballyRoutableAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("allows owner loopback endpoints but blocks them for other users and always blocks metadata", async () => {
    await expect(
      assertOpenAICompatibleBaseUrlAllowed("http://127.0.0.1:11434/v1", {
        allowPrivateNetwork: true,
      }),
    ).resolves.toBe("http://127.0.0.1:11434/v1");
    await expect(assertOpenAICompatibleBaseUrlAllowed("http://127.0.0.1:11434/v1")).rejects.toThrow(
      /private or local/,
    );
    await expect(
      assertOpenAICompatibleBaseUrlAllowed("http://169.254.169.254/v1", {
        allowPrivateNetwork: true,
      }),
    ).rejects.toThrow(/prohibited/);
    await expect(
      assertOpenAICompatibleBaseUrlAllowed("http://10.0.0.8/v1", {
        allowPrivateNetwork: true,
        hasCredentials: true,
      }),
    ).rejects.toThrow(/credentials require HTTPS/);
  });

  it("lists models from a bounded local fake gateway without requiring a key", async () => {
    const server = createServer((request, response) => {
      expect(request.url).toBe("/v1/models");
      expect(request.headers.authorization).toBeUndefined();
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "fake-model" }, { id: "fake-model" }] }));
    });
    servers.push(server);
    const baseUrl = await listen(server);

    await expect(
      fetchOpenAICompatibleModels(`${baseUrl}/v1`, undefined, undefined, {
        allowPrivateNetwork: true,
      }),
    ).resolves.toEqual(["fake-model"]);
  });

  it("removes credentials before following a cross-origin redirect", async () => {
    let redirectedAuthorization: string | undefined;
    const destination = createServer((request, response) => {
      redirectedAuthorization = request.headers.authorization;
      response.end("ok");
    });
    servers.push(destination);
    const destinationUrl = await listen(destination);
    const source = createServer((_request, response) => {
      response.statusCode = 307;
      response.setHeader("location", destinationUrl);
      response.end();
    });
    servers.push(source);
    const sourceUrl = await listen(source);

    const response = await createOpenAICompatibleFetch({ allowPrivateNetwork: true })(sourceUrl, {
      headers: { authorization: "Bearer fake-gateway-key" },
    });

    expect(await response.text()).toBe("ok");
    expect(redirectedAuthorization).toBeUndefined();
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
});

function listen(server: ReturnType<typeof createServer>): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.removeListener("error", reject);
      const address = server.address();
      if (!address || typeof address === "string") return reject(new Error("Missing test port"));
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}
