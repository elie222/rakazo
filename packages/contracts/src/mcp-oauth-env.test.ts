import { describe, expect, it } from "vitest";
import {
  mcpOAuthEnvReferences,
  parseMcpOAuthAuthorizationParams,
  resolveMcpOAuthEnv,
  resolveMcpOAuthTemplate,
} from "./mcp.js";

describe("MCP OAuth env references", () => {
  it("finds the referenced fields and flags unknown ones", () => {
    expect(mcpOAuthEnvReferences("Bearer {{oauth.access_token}}")).toEqual({
      fields: ["access_token"],
      unknown: [],
    });
    expect(mcpOAuthEnvReferences("{{ oauth.refresh_token }}{{oauth.id_token}}")).toEqual({
      fields: ["refresh_token"],
      unknown: ["id_token"],
    });
    expect(mcpOAuthEnvReferences("plain-value")).toEqual({ fields: [], unknown: [] });
  });

  it("replaces references and leaves other values alone", () => {
    expect(
      resolveMcpOAuthEnv(
        { TOKEN: "{{oauth.access_token}}", AUTH: "Bearer {{oauth.access_token}}", MODE: "prod" },
        { access_token: "ya29.token" },
      ),
    ).toEqual({ TOKEN: "ya29.token", AUTH: "Bearer ya29.token", MODE: "prod" });
  });

  it("refuses to start with a missing value instead of passing the placeholder", () => {
    expect(() =>
      resolveMcpOAuthEnv({ REFRESH: "{{oauth.refresh_token}}" }, { access_token: "a" }),
    ).toThrow("oauth.refresh_token is not available for REFRESH");
    expect(() => resolveMcpOAuthEnv({ X: "{{oauth.id_token}}" }, {})).toThrow("oauth.id_token");
  });

  it("fills a credential file template, naming the file in errors", () => {
    expect(
      resolveMcpOAuthTemplate(
        '{"refresh_token":"{{oauth.refresh_token}}","expiry_date":{{oauth.expires_at}}}',
        { refresh_token: "1//r", expires_at: "1792578000000" },
        "GOOGLE_TOKENS",
      ),
    ).toBe('{"refresh_token":"1//r","expiry_date":1792578000000}');
    expect(() => resolveMcpOAuthTemplate("{{oauth.scope}}", {}, "GOOGLE_TOKENS")).toThrow(
      "oauth.scope is not available for GOOGLE_TOKENS",
    );
  });

  it("parses extra authorization parameters and refuses to override the flow's own", () => {
    expect(parseMcpOAuthAuthorizationParams("access_type=offline&prompt=consent")).toEqual({
      access_type: "offline",
      prompt: "consent",
    });
    expect(parseMcpOAuthAuthorizationParams("")).toEqual({});
    expect(() => parseMcpOAuthAuthorizationParams("redirect_uri=https://evil.example")).toThrow(
      "redirect_uri",
    );
    expect(() => parseMcpOAuthAuthorizationParams("scope=a")).toThrow("scope");
  });
});
