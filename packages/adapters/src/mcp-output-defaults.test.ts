import { describe, expect, it } from "vitest";
import { MCP_FILE_ENV_DEFAULTS, mcpFileEnvDefaults } from "./mcp-output-defaults.js";

describe("known MCP package file folders", () => {
  it("points Gmail MCP's download and attachment jails at the workspace", () => {
    expect(mcpFileEnvDefaults("@klodr/gmail-mcp")).toEqual({
      outputEnv: ["GMAIL_MCP_DOWNLOAD_DIR"],
      inputEnv: ["GMAIL_MCP_ATTACHMENT_DIR"],
    });
    expect(mcpFileEnvDefaults("@klodr/gmail-mcp@1.4.2")).toEqual(
      mcpFileEnvDefaults("@klodr/gmail-mcp"),
    );
    expect(mcpFileEnvDefaults("@klodr/gmail-mcp@latest")).toEqual(
      mcpFileEnvDefaults("@klodr/gmail-mcp"),
    );
  });

  it("knows nothing about other packages or specs that are not registry packages", () => {
    expect(mcpFileEnvDefaults("@other/gmail-mcp")).toEqual({});
    expect(mcpFileEnvDefaults("constructor")).toEqual({});
    expect(mcpFileEnvDefaults("./local/gmail-mcp")).toEqual({});
    expect(mcpFileEnvDefaults(undefined)).toEqual({});
  });

  it("names only valid env variables", () => {
    for (const entry of Object.values(MCP_FILE_ENV_DEFAULTS))
      for (const key of [...(entry.outputEnv ?? []), ...(entry.inputEnv ?? [])])
        expect(key).toMatch(/^[A-Z_][A-Z0-9_]*$/);
  });
});
