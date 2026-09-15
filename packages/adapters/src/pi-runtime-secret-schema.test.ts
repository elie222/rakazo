import { describe, expect, it } from "vitest";

import { builtinAgentTools } from "./builtin-tools.js";
import { parseConnectorToolArgs } from "./lazy-tool-catalog.js";
import {
  jsonField,
  jsonSchemaParameters,
  parametersFor,
  prepareRequestSecretArguments,
} from "./pi-runtime.js";

/**
 * `pi-runtime` used to re-declare `request_secret`'s parameters by hand, and the
 * copy omitted `credential`. The model therefore never saw the one argument that
 * makes a credential persist: `request_secret` calls arrived with only
 * `{label, purpose}`, the submitted value had nowhere to be stored, and the tool
 * looked broken from the outside.
 *
 * These assert the canonical schema still carries what the executor requires, so
 * a future hand-rolled override has to fail here rather than silently drop a
 * field again — including the credential XOR connectionId exclusivity the
 * executor enforces.
 */
function toolNamed(name: string) {
  const tool = builtinAgentTools.find((entry) => entry.name === name);
  if (!tool) throw new Error(`missing builtin tool ${name}`);
  return tool;
}

function requestSecretSchema() {
  return toolNamed("request_secret").inputSchema as Record<string, unknown>;
}

function oneOfBranches(schema: Record<string, unknown>) {
  const branches = Array.isArray(schema.oneOf) ? schema.oneOf : [];
  return branches as Array<{
    properties?: Record<string, { properties?: Record<string, unknown> }>;
    required?: string[];
  }>;
}

const sampleCredential = {
  name: "github_pat",
  origin: "https://api.github.com",
  auth: { type: "bearer" },
};

describe("request_secret parameters", () => {
  it("exposes credential on the destination branch the executor persists", () => {
    const credentialBranch = oneOfBranches(requestSecretSchema()).find((branch) =>
      (branch.required ?? []).includes("credential"),
    );
    expect(credentialBranch?.properties).toHaveProperty("credential");
  });

  it("describes the credential destination fields the executor validates", () => {
    const credentialBranch = oneOfBranches(requestSecretSchema()).find((branch) =>
      (branch.required ?? []).includes("credential"),
    );
    const credential = credentialBranch?.properties?.credential?.properties ?? {};
    // normalizeSecretDestination rejects the call unless all three resolve.
    expect(Object.keys(credential).sort()).toEqual(["auth", "name", "origin"]);
  });

  it("exposes connectionId on the mutually exclusive alternative branch", () => {
    const connectionBranch = oneOfBranches(requestSecretSchema()).find((branch) =>
      (branch.required ?? []).includes("connectionId"),
    );
    expect(connectionBranch?.properties).toHaveProperty("connectionId");
  });

  it("rejects both destinations and neither, matching the executor", () => {
    const schema = requestSecretSchema();
    expect(() =>
      parseConnectorToolArgs(schema, {
        label: "GitHub PAT",
        purpose: "api_key",
        credential: sampleCredential,
        connectionId: "conn_1",
      }),
    ).toThrow();
    expect(() =>
      parseConnectorToolArgs(schema, { label: "GitHub PAT", purpose: "api_key" }),
    ).toThrow();
    expect(
      parseConnectorToolArgs(schema, {
        label: "GitHub PAT",
        purpose: "api_key",
        credential: sampleCredential,
      }),
    ).toMatchObject({ credential: sampleCredential });
    expect(
      parseConnectorToolArgs(schema, {
        label: "c",
        purpose: "otp",
        connectionId: "abc",
      }),
    ).toMatchObject({ connectionId: "abc" });
  });

  it("rejects connectionId with replace, which belongs only on the credential branch", () => {
    expect(() =>
      parseConnectorToolArgs(requestSecretSchema(), {
        label: "c",
        purpose: "otp",
        connectionId: "abc",
        replace: true,
      }),
    ).toThrow();
  });

  it("keeps exclusivity when converted for the PI model", () => {
    const converted = jsonSchemaParameters(requestSecretSchema()) as {
      anyOf?: unknown[];
      oneOf?: unknown[];
    };
    // Type.Union serializes as anyOf; the model must still see two exclusive shapes.
    const variants = converted.anyOf ?? converted.oneOf ?? [];
    expect(variants.length).toBe(2);
  });

  it("keeps converted destination variants closed so both destinations cannot match", () => {
    const converted = jsonSchemaParameters(requestSecretSchema()) as {
      anyOf?: Array<{ additionalProperties?: unknown }>;
      oneOf?: Array<{ additionalProperties?: unknown }>;
    };
    const variants = converted.anyOf ?? converted.oneOf ?? [];
    expect(variants).toHaveLength(2);
    for (const variant of variants) {
      expect(variant.additionalProperties).toBe(false);
    }
  });

  it("exposes OpenAI-compatible parameters.type object for local servers", () => {
    // LM Studio and similar validators reject tools[].function.parameters without
    // type === "object" (and often without properties). request_secret is the
    // builtin that previously serialized as a bare anyOf union.
    const wire = JSON.parse(JSON.stringify(parametersFor(toolNamed("request_secret")))) as {
      type?: unknown;
      properties?: unknown;
      anyOf?: unknown[];
      oneOf?: unknown[];
    };
    expect(wire.type).toBe("object");
    expect(wire.properties).toEqual({});
    expect((wire.anyOf ?? wire.oneOf ?? []).length).toBe(2);
  });
});

describe("prepareRequestSecretArguments", () => {
  it("keeps credential, which is what makes the value persist", () => {
    expect(
      prepareRequestSecretArguments({
        label: "GitHub PAT",
        purpose: "api_key",
        credential: sampleCredential,
      }),
    ).toEqual({ label: "GitHub PAT", purpose: "api_key", credential: sampleCredential });
  });

  it("keeps replace, so an existing credential can be overwritten", () => {
    const credential = { name: "x", origin: "https://api.example.com", auth: { type: "bearer" } };
    const out = prepareRequestSecretArguments({
      label: "x",
      purpose: "api_key",
      credential,
      replace: true,
    });
    expect(out).toMatchObject({ replace: true, credential });
  });

  it("still passes connectionId for the connector-code path", () => {
    const out = prepareRequestSecretArguments({ label: "c", purpose: "otp", connectionId: "abc" });
    expect(out).toEqual({ label: "c", purpose: "otp", connectionId: "abc" });
  });

  it("omits credential and connectionId when absent rather than sending empties", () => {
    // The executor rejects a call that carries both, so neither may be faked in.
    expect(prepareRequestSecretArguments({ label: "c", purpose: "otp" })).toEqual({
      label: "c",
      purpose: "otp",
    });
  });
});

describe("jsonField union handling", () => {
  it("converts a discriminated union instead of defaulting to string", () => {
    // BotSecretAuth converts to oneOf with no sibling `type`. Treating that as a
    // string told the model to send `auth: "bearer"`, which the executor then
    // rejected -- observed twice against the live deployment.
    const authSchema = {
      oneOf: [
        { type: "object", properties: { type: { type: "string", const: "bearer" } } },
        {
          type: "object",
          properties: { type: { type: "string", const: "header" }, name: { type: "string" } },
        },
      ],
    };
    // A string schema converts to {type:"string"}; a union must not.
    expect((jsonField(authSchema) as { type?: string }).type).not.toBe("string");
  });

  it("still treats a plain string schema as a string", () => {
    expect((jsonField({ type: "string" }) as { type?: string }).type).toBe("string");
  });
});

describe("jsonField const handling", () => {
  it("preserves a const so the model knows the only accepted value", () => {
    // BotSecretAuth's discriminator is {type: {type:"string", const:"bearer"}}.
    // Degrading that to a plain string left the model guessing: recorded calls
    // sent auth.type as "api_key" and "authorization_bearer" before this.
    // enumUnion wraps literals, so the value lands inside a single-member union.
    expect(JSON.stringify(jsonField({ type: "string", const: "bearer" }))).toContain(
      '"const":"bearer"',
    );
  });

  it("leaves a plain string alone", () => {
    expect(JSON.stringify(jsonField({ type: "string" }))).not.toContain("const");
  });
});
