import { registryPackageName } from "./mcp-package-installer.js";

/**
 * Env variables a known stdio MCP package reads for its file folders. Rakazo points each at the
 * process's managed folders, overriding any value the user set, so files move between tools
 * with no configuration:
 * - `outputEnv`: where the server saves files it produces; Rakazo sets `<workspace>/out`, and
 *   paths a result names there become temporary tool files.
 * - `inputEnv`: where the server reads files it is given by path; Rakazo sets `<workspace>/in`,
 *   where `{{file_path:ID}}` copies are written.
 */
export type McpFileEnvDefaults = { outputEnv?: readonly string[]; inputEnv?: readonly string[] };

/** One line per package, keyed by the npm package name without a version. */
export const MCP_FILE_ENV_DEFAULTS: Readonly<Record<string, McpFileEnvDefaults>> = {
  // download_attachment saves into its download jail and names the saved path; send_email,
  // reply and forward_email only attach absolute paths inside the attachment jail.
  "@klodr/gmail-mcp": {
    outputEnv: ["GMAIL_MCP_DOWNLOAD_DIR"],
    inputEnv: ["GMAIL_MCP_ATTACHMENT_DIR"],
  },
};

/** The file folder env variables for an npx package spec; empty for an unknown package. */
export function mcpFileEnvDefaults(spec: string | undefined): McpFileEnvDefaults {
  const name = spec ? registryPackageName(spec) : undefined;
  return name && Object.hasOwn(MCP_FILE_ENV_DEFAULTS, name)
    ? (MCP_FILE_ENV_DEFAULTS[name] ?? {})
    : {};
}
