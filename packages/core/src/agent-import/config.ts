import JSON5 from "json5";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

/** Settings files read from the root of an OpenClaw or Hermes home. */
export const AGENT_IMPORT_CONFIG_FILES = new Set([
  "openclaw.json",
  ".env",
  "config.yaml",
  "auth.json",
  "cron/jobs.json",
  "skills/.bundled_manifest",
]);

/** Files that hold nothing but credentials; read only when the user opts in. */
const SECRET_FILES = new Set([".env", "auth.json"]);

export function isAgentImportSecretFile(path: string): boolean {
  return SECRET_FILES.has(path);
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Parses a settings file: `openclaw.json` and the JSON job lists are JSON5 (comments and
 * trailing commas allowed), `config.yaml` is YAML. Null when it is not an object.
 */
export function readAgentImportConfig(path: string, content: string): Json | null {
  try {
    const value: unknown =
      path === "config.yaml" ? parseYaml(content) : (JSON5.parse(content) as unknown);
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * What a settings file may carry without the user opting in to API keys: only the parts an
 * import reads, with credential values blanked. Applied in the browser before upload and
 * again on the server, so a value that is not opted in is never sent or read. Secret files
 * and files that cannot be parsed become empty.
 *
 * Kept: the agent's model, workspace folder names and MCP servers (header and env names
 * only). Dropped: everything else, including `gateway`, `channels`, `env`, `models`,
 * Hermes `providers`, `custom_providers` and `model.api_key`.
 */
export function stripAgentImportSecrets(path: string, content: string): string {
  if (SECRET_FILES.has(path)) return "";
  if (path !== "openclaw.json" && path !== "config.yaml") return content;
  const config = readAgentImportConfig(path, content);
  if (!config) return "";
  if (path === "config.yaml") {
    const model = isObject(config.model) ? config.model : {};
    return stringifyYaml({
      model: pick(model, ["default", "model", "provider"]),
      mcp_servers: mcpServersWithoutValues(config.mcp_servers),
    });
  }
  const agents = isObject(config.agents) ? config.agents : {};
  const defaults = isObject(agents.defaults) ? agents.defaults : {};
  const agent = (value: unknown) => {
    const entry = isObject(value) ? value : {};
    return {
      ...pick(entry, ["id", "model"]),
      ...(typeof entry.workspace === "string" ? { workspace: folderName(entry.workspace) } : {}),
    };
  };
  const mcp = isObject(config.mcp) ? config.mcp : {};
  return JSON.stringify(
    {
      agents: {
        defaults: pick(defaults, ["model"]),
        entries: Object.fromEntries(
          Object.entries(isObject(agents.entries) ? agents.entries : {}).map(([id, entry]) => [
            id,
            agent(entry),
          ]),
        ),
        list: Array.isArray(agents.list) ? agents.list.map(agent) : [],
      },
      mcp: { servers: mcpServersWithoutValues(mcp.servers) },
    },
    null,
    2,
  );
}

/** True when a file holds something the API key opt-in would add. */
export function hasAgentImportSecrets(path: string, content: string): boolean {
  if (SECRET_FILES.has(path)) return content.trim() !== "";
  if (path !== "openclaw.json" && path !== "config.yaml") return false;
  const config = readAgentImportConfig(path, content);
  if (!config) return false;
  const filled = (value: unknown) =>
    isObject(value) && Object.values(value).some((entry) => entry !== "" && entry != null);
  const servers = Object.values(
    (path === "config.yaml" ? config.mcp_servers : (config.mcp as Json | undefined)?.servers) ?? {},
  );
  if (servers.some((server) => isObject(server) && (filled(server.headers) || filled(server.env))))
    return true;
  if (path === "config.yaml") {
    const providers = [
      ...Object.values(isObject(config.providers) ? config.providers : {}),
      ...(Array.isArray(config.custom_providers) ? config.custom_providers : []),
      config.model,
    ];
    return providers.some((entry) => isObject(entry) && Boolean(entry.api_key));
  }
  const models = isObject(config.models) ? config.models : {};
  const providers = Object.values(isObject(models.providers) ? models.providers : {});
  return (
    filled(config.env) || providers.some((entry) => isObject(entry) && entry.apiKey !== undefined)
  );
}

function mcpServersWithoutValues(value: unknown): Json {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([name, server]) => {
      const entry = isObject(server) ? server : {};
      const names = (record: unknown) =>
        isObject(record) ? Object.fromEntries(Object.keys(record).map((key) => [key, ""])) : {};
      return [
        name,
        {
          ...pick(entry, [
            "url",
            "transport",
            "type",
            "command",
            "args",
            "enabled",
            "toolFilter",
            "tools",
          ]),
          // Only that these exist: an import cannot express them, and they may hold secrets.
          ...(entry.oauth !== undefined || entry.auth !== undefined ? { auth: true } : {}),
          ...(entry.tls !== undefined || entry.cert !== undefined || entry.clientCert !== undefined
            ? { tls: true }
            : {}),
          ...(entry.$include !== undefined ? { $include: true } : {}),
          headers: names(entry.headers),
          env: names(entry.env),
        },
      ];
    }),
  );
}

function pick(source: Json, keys: readonly string[]): Json {
  return Object.fromEntries(keys.filter((key) => key in source).map((key) => [key, source[key]]));
}

function folderName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) ?? ""
  );
}
