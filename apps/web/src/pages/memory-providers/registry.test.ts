import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  SERENITY_ENDPOINT_PLACEHOLDER,
  serenityConnectionDraft,
  serenityEndpointError,
} from "./serenity-settings";

describe("Serenity memory provider settings", () => {
  it("does not register a default endpoint", () => {
    const registry = readFileSync(fileURLToPath(new URL("./registry.ts", import.meta.url)), "utf8");
    expect(registry).toContain("Hosted or self-hosted Serenity brain for durable memory.");
    expect(registry).not.toContain("serenity.sire.run");
    expect(registry).not.toContain("DEFAULT_ENDPOINT");
    expect(SERENITY_ENDPOINT_PLACEHOLDER).toBe("https://serenity.sire.run/mcp");

    const form = readFileSync(
      fileURLToPath(new URL("./SerenitySettingsForm.tsx", import.meta.url)),
      "utf8",
    );
    expect(form).not.toContain("DEFAULT_ENDPOINT");
    expect(form).toContain('const [endpoint, setEndpoint] = useState("");');
    expect(form).not.toContain("useState(SERENITY_ENDPOINT_PLACEHOLDER)");
    expect(form).toContain("required");
    expect(form).toContain("placeholder={SERENITY_ENDPOINT_PLACEHOLDER}");
  });

  it("requires an explicit endpoint and leaves URL validity to the backend", () => {
    expect(serenityEndpointError("")).toBe("required");
    expect(serenityEndpointError("   ")).toBe("required");
    expect(serenityEndpointError("not a url")).toBeNull();
    expect(serenityEndpointError("ftp://serenity.example.test/mcp")).toBeNull();
    expect(serenityEndpointError("https://user:pass@serenity.example.test/mcp")).toBeNull();
    expect(serenityEndpointError("https://serenity.example.test/mcp?x=1")).toBeNull();
    expect(serenityEndpointError(SERENITY_ENDPOINT_PLACEHOLDER)).toBeNull();

    expect(
      serenityConnectionDraft({
        endpoint: "",
        token: "serenity_token",
        brainLabel: "",
        allowWrites: false,
      }),
    ).toEqual({ ok: false, error: "required" });

    expect(
      serenityConnectionDraft({
        endpoint: "not a url",
        token: "serenity_token",
        brainLabel: "",
        allowWrites: false,
      }),
    ).toEqual({
      ok: true,
      draft: {
        settings: { endpoint: "not a url", allowWrites: "false" },
        credentials: { token: "serenity_token" },
      },
    });

    expect(
      serenityConnectionDraft({
        endpoint: SERENITY_ENDPOINT_PLACEHOLDER,
        token: "sk_live_example",
        brainLabel: " personal ",
        allowWrites: true,
      }),
    ).toEqual({
      ok: true,
      draft: {
        settings: {
          endpoint: "https://serenity.sire.run/mcp",
          allowWrites: "true",
          brainLabel: "personal",
        },
        credentials: { token: "sk_live_example" },
      },
    });
  });
});
