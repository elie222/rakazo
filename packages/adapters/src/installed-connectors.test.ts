import { describe, expect, it } from "vitest";
import {
  importOpenApiDocument,
  prepareApiInstall,
  verifyMcpInstall,
} from "./installed-connectors.js";

describe("OpenAPI connector import", () => {
  it("maps operation ids, parameters, and JSON bodies to bounded agent tools", () => {
    const imported = importOpenApiDocument({
      openapi: "3.1.0",
      servers: [{ url: "https://api.example.test/v1" }],
      paths: {
        "/contacts/{contactId}": {
          parameters: [
            {
              name: "contactId",
              in: "path",
              required: true,
              schema: { type: "string" },
            },
          ],
          patch: {
            operationId: "updateContact",
            summary: "Update one contact",
            requestBody: {
              required: true,
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    properties: { name: { type: "string" } },
                  },
                },
              },
            },
          },
        },
      },
    });

    expect(imported.baseUrl).toBe("https://api.example.test/v1");
    expect(imported.operations).toEqual([
      expect.objectContaining({
        id: "updateContact",
        method: "PATCH",
        path: "/contacts/{contactId}",
        readOnly: false,
        inputSchema: expect.objectContaining({ required: ["contactId", "body"] }),
      }),
    ]);
  });

  it("refuses ambiguous specs without stable operation ids", () => {
    expect(() =>
      importOpenApiDocument({
        servers: [{ url: "https://api.example.test" }],
        paths: { "/contacts": { get: { summary: "List contacts" } } },
      }),
    ).toThrow("operationId");
  });

  it("refuses credentials embedded in an imported OpenAPI server URL", () => {
    expect(() =>
      importOpenApiDocument({
        servers: [{ url: "https://api.example.test?token=fake-secret" }],
        paths: { "/contacts": { get: { operationId: "listContacts" } } },
      }),
    ).toThrow("encrypted credential field");
  });

  it("refuses sensitive headers that would become model-controlled inputs", () => {
    expect(() =>
      importOpenApiDocument({
        servers: [{ url: "https://api.example.test" }],
        paths: {
          "/contacts": {
            get: {
              operationId: "listContacts",
              parameters: [{ name: "Authorization", in: "header", schema: { type: "string" } }],
            },
          },
        },
      }),
    ).toThrow("unsafe header Authorization");
  });

  it("refuses credentials embedded in a persisted MCP URL", async () => {
    await expect(
      verifyMcpInstall({
        source: "https://connectors.example.test/mcp?access_token=fake-secret",
        config: { preset: "custom", auth: { type: "none" } },
      }),
    ).rejects.toThrow("encrypted credential field");
  });

  it("refuses model-controlled sensitive headers in authored API operations", async () => {
    await expect(
      prepareApiInstall({
        source: "https://93.184.216.34",
        config: {
          auth: { type: "bearer" },
          operations: [
            {
              id: "unsafe",
              method: "GET",
              path: "/contacts",
              headerParameters: ["authorization"],
            },
          ],
        },
        credential: "fake-credential",
      }),
    ).rejects.toThrow("Sensitive headers cannot be model-controlled");
  });
});
