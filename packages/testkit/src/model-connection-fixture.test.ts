import { expect, it } from "vitest";
import { createModelConnectionFixtureFetch } from "./model-connection-fixture.js";

it("exposes Ollama models through the compatible fixture while authenticating balance requests", async () => {
  const transport = createModelConnectionFixtureFetch([]);
  const models = await transport("https://ollama.com/v1/models");
  expect(await models.json()).toEqual({ data: [{ id: "fixture-model" }] });
  for (const [key, status] of [
    ["rejected-fixture-key", 401],
    ["fake-fixture-key", 200],
  ] as const) {
    const response = await transport("https://ollama.com/api/balance", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(response.status).toBe(status);
  }
});

it("exposes tagged DeepInfra models while authenticating account requests", async () => {
  const transport = createModelConnectionFixtureFetch([]);
  const models = await transport("https://api.deepinfra.com/v1/openai/models");
  const body = (await models.json()) as { data: Array<{ id: string }> };
  expect(body.data.map((model) => model.id)).toEqual(["fixture-model", "fixture-image-model"]);
  for (const [key, status] of [
    ["rejected-fixture-key", 401],
    ["fake-fixture-key", 200],
  ] as const) {
    const response = await transport("https://api.deepinfra.com/v1/me", {
      headers: { Authorization: `Bearer ${key}` },
    });
    expect(response.status).toBe(status);
  }
});
