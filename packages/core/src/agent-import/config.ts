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
 * trailing commas allowed), `config.yaml` is YAML. Null when it is not a plain object, when
 * it nests too deeply, or when it names a prototype key; YAML aliases are capped and only
 * the core schema is understood.
 */
export function readAgentImportConfig(path: string, content: string): Json | null {
  try {
    const value: unknown =
      path === "config.yaml"
        ? parseYaml(content, { maxAliasCount: 20, schema: "core", customTags: [] })
        : (JSON5.parse(content) as unknown);
    return isObject(value) && safeTree(value, 0) ? value : null;
  } catch {
    return null;
  }
}

const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_DEPTH = 32;

function safeTree(value: unknown, depth: number): boolean {
  if (depth > MAX_DEPTH) return false;
  if (Array.isArray(value)) return value.every((item) => safeTree(item, depth + 1));
  if (!isObject(value)) return true;
  return Object.keys(value).every(
    (key) => !UNSAFE_KEYS.has(key) && safeTree(value[key], depth + 1),
  );
}

/** Provider-key variables an import may read; anything else (channel tokens, ...) is not. */
export const AGENT_IMPORT_PROVIDER_KEYS: Readonly<Record<string, string>> = {
  OPENROUTER_API_KEY: "openrouter",
  ANTHROPIC_API_KEY: "anthropic",
  OPENAI_API_KEY: "openai",
  GEMINI_API_KEY: "google",
  GOOGLE_API_KEY: "google",
  DEEPSEEK_API_KEY: "deepseek",
  XAI_API_KEY: "xai",
  MINIMAX_API_KEY: "minimax",
  KIMI_API_KEY: "kimi-coding",
  MOONSHOT_API_KEY: "moonshotai",
  MISTRAL_API_KEY: "mistral",
  GROQ_API_KEY: "groq",
};
const KEY_PROVIDERS = new Set(Object.values(AGENT_IMPORT_PROVIDER_KEYS));

/** Provider names the source tools use for Rakazo's catalog providers. */
const PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  gemini: "google",
  "google-gemini": "google",
  claude: "anthropic",
  "x-ai": "xai",
  grok: "xai",
  kimi: "kimi-coding",
  moonshot: "moonshotai",
  "z-ai": "zai",
  zhipu: "zai",
};

export function normalizeImportProvider(provider: string): string {
  const id = provider.trim().toLowerCase();
  return PROVIDER_ALIASES[id] ?? id;
}

/** `KEY=value` lines, with optional `export` and quotes; comments and blanks ignored. */
export function parseDotEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    if (line.trimStart().startsWith("#")) continue;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match) continue;
    let value = match[2]!;
    const quoted = /^(['"])(.*)\1$/.exec(value);
    value = quoted ? quoted[2]! : value.replace(/\s+#.*$/, "");
    values[match[1]!] = value;
  }
  return values;
}

/**
 * The files an upload may carry, from a home's files by path. Applied in the browser before
 * anything is sent, and again on the server, so both agree on one rule.
 *
 * Without the API key opt-in, settings keep only what an import reads, with credential
 * values blanked, and `.env`/`auth.json` are not sent at all. With it, the same projection
 * also keeps model-provider keys on the allowlist (and `.env` names those keys refer to),
 * and `.env`/`auth.json` keep only those entries, re-written. MCP header and env values,
 * gateway and channel tokens, OAuth grants and other settings are not copied, in either
 * mode, and MCP servers outside a conservative rule are reduced to their names. This limits
 * what is sent; it cannot recognise every secret a source puts in an unexpected place.
 * Files that cannot be parsed become empty.
 */
export function prepareAgentImportFiles(
  files: ReadonlyMap<string, string>,
  options: { includeSecrets: boolean },
): Map<string, string> {
  const out = new Map<string, string>();
  const referenced = new Set<string>();
  for (const [path, content] of files) {
    if (SECRET_FILES.has(path)) continue;
    if (path === "openclaw.json" || path === "config.yaml") {
      const config = readAgentImportConfig(path, content);
      out.set(path, config ? projectConfig(path, config, options.includeSecrets, referenced) : "");
    } else {
      out.set(path, content);
    }
  }
  if (!options.includeSecrets) return out;
  const env = files.get(".env");
  if (env !== undefined) {
    const lines = Object.entries(parseDotEnv(env))
      .filter(([name]) => name in AGENT_IMPORT_PROVIDER_KEYS || referenced.has(name))
      .map(([name, value]) => `${name}="${value}"`);
    out.set(".env", lines.length ? `${lines.join("\n")}\n` : "");
  }
  const auth = files.get("auth.json");
  if (auth !== undefined) out.set("auth.json", JSON.stringify(manualKeys(auth)));
  return out;
}

/** The single-file form of the rule without the opt-in. */
export function stripAgentImportSecrets(path: string, content: string): string {
  return (
    prepareAgentImportFiles(new Map([[path, content]]), { includeSecrets: false }).get(path) ?? ""
  );
}

function projectConfig(
  path: string,
  config: Json,
  secrets: boolean,
  referenced: Set<string>,
): string {
  const keyed = (name: string) => KEY_PROVIDERS.has(normalizeImportProvider(name));
  // MCP header and env values are not copied: only their names.
  const servers = (value: unknown) => mcpServers(value);
  if (path === "config.yaml") {
    const model = isObject(config.model) ? config.model : {};
    const keepModelKey = secrets && keyed(String(model.provider ?? ""));
    const providers = Object.entries(isObject(config.providers) ? config.providers : {}).flatMap(
      ([name, entry]) =>
        secrets && keyed(name) && isObject(entry) && entry.api_key !== undefined
          ? [[name, { api_key: noteReferences(entry.api_key, referenced) }]]
          : [],
    );
    const custom = (Array.isArray(config.custom_providers) ? config.custom_providers : []).flatMap(
      (entry) =>
        secrets && isObject(entry) && keyed(String(entry.name ?? "")) && entry.api_key !== undefined
          ? [{ name: String(entry.name), api_key: noteReferences(entry.api_key, referenced) }]
          : [],
    );
    return stringifyYaml({
      model: {
        ...strings(model, ["default", "model", "provider"]),
        ...(keepModelKey && model.api_key !== undefined
          ? { api_key: noteReferences(model.api_key, referenced) }
          : {}),
      },
      ...(providers.length ? { providers: Object.fromEntries(providers) } : {}),
      ...(custom.length ? { custom_providers: custom } : {}),
      mcp_servers: servers(config.mcp_servers),
    });
  }
  const agents = isObject(config.agents) ? config.agents : {};
  const defaults = isObject(agents.defaults) ? agents.defaults : {};
  const agent = (value: unknown) => {
    const entry = isObject(value) ? value : {};
    return {
      ...strings(entry, ["id"]),
      ...modelName(entry.model),
      ...(typeof entry.workspace === "string" ? { workspace: folderName(entry.workspace) } : {}),
    };
  };
  const mcp = isObject(config.mcp) ? config.mcp : {};
  const projected: Json = {
    agents: {
      defaults: modelName(defaults.model),
      entries: Object.fromEntries(
        Object.entries(isObject(agents.entries) ? agents.entries : {}).map(([id, entry]) => [
          id,
          agent(entry),
        ]),
      ),
      list: Array.isArray(agents.list) ? agents.list.map(agent) : [],
    },
    mcp: { servers: servers(mcp.servers) },
  };
  if (secrets) {
    const models = isObject(config.models) ? config.models : {};
    const providers = Object.entries(isObject(models.providers) ? models.providers : {}).flatMap(
      ([id, entry]) =>
        keyed(id) && isObject(entry) && entry.apiKey !== undefined
          ? [[id, { apiKey: noteReferences(entry.apiKey, referenced) }]]
          : [],
    );
    const env = isObject(config.env) ? config.env : {};
    const vars = {
      ...env,
      ...(isObject(env.vars) ? env.vars : {}),
    };
    const allowed = Object.entries(vars).filter(
      ([name, value]) => name in AGENT_IMPORT_PROVIDER_KEYS && typeof value === "string",
    );
    if (providers.length) projected.models = { providers: Object.fromEntries(providers) };
    if (allowed.length) projected.env = { vars: Object.fromEntries(allowed) };
  }
  return JSON.stringify(projected, null, 2);
}

/** Records the `.env` names a value refers to (`${NAME}` or an env SecretRef). */
function noteReferences(value: unknown, referenced: Set<string>): unknown {
  // Only a plain string or an env SecretRef `{ source: "env", id }`; nothing else is copied.
  if (isObject(value)) {
    if (value.source !== "env" || typeof value.id !== "string") return undefined;
    referenced.add(value.id);
    return { source: "env", id: value.id };
  }
  if (typeof value !== "string") return undefined;
  for (const match of value.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g)) referenced.add(match[1]!);
  return value;
}

/** Hermes `auth.json`: only API keys the user entered by hand, for allowlisted providers. */
function manualKeys(content: string): Json {
  const auth = readAgentImportConfig("auth.json", content) ?? {};
  const pool = isObject(auth.credential_pool) ? auth.credential_pool : {};
  const kept = Object.entries(pool).flatMap(([provider, entries]) => {
    if (!KEY_PROVIDERS.has(normalizeImportProvider(provider))) return [];
    const manual = (Array.isArray(entries) ? entries : []).filter(
      (entry) => isObject(entry) && entry.auth_type === "api_key" && entry.source === "manual",
    );
    return manual.length
      ? [
          [
            provider,
            manual.map((entry) => strings(entry as Json, ["auth_type", "source", "access_token"])),
          ],
        ]
      : [];
  });
  return { credential_pool: Object.fromEntries(kept) };
}

/** True when a settings file holds a model-provider key the API key opt-in would add. */
export function hasAgentImportSecrets(path: string, content: string): boolean {
  if (SECRET_FILES.has(path)) return content.trim() !== "";
  if (path !== "openclaw.json" && path !== "config.yaml") return false;
  const config = readAgentImportConfig(path, content);
  if (!config) return false;
  const keyed = (name: unknown) => KEY_PROVIDERS.has(normalizeImportProvider(String(name ?? "")));
  if (path === "config.yaml") {
    const model = isObject(config.model) ? config.model : {};
    return (
      (keyed(model.provider) && Boolean(model.api_key)) ||
      Object.entries(isObject(config.providers) ? config.providers : {}).some(
        ([name, entry]) => keyed(name) && isObject(entry) && Boolean(entry.api_key),
      ) ||
      (Array.isArray(config.custom_providers) ? config.custom_providers : []).some(
        (entry) => isObject(entry) && keyed(entry.name) && Boolean(entry.api_key),
      )
    );
  }
  const models = isObject(config.models) ? config.models : {};
  const env = isObject(config.env) ? config.env : {};
  const vars = { ...env, ...(isObject(env.vars) ? env.vars : {}) };
  return (
    Object.entries(isObject(models.providers) ? models.providers : {}).some(
      ([id, entry]) => keyed(id) && isObject(entry) && entry.apiKey !== undefined,
    ) || Object.keys(vars).some((name) => name in AGENT_IMPORT_PROVIDER_KEYS)
  );
}

/** A flag whose name suggests it carries a credential or a header (`--api-key`, `--header`). */
const CREDENTIAL_FLAG = /(?:key|token|secret|pass|auth|header|credential|bearer|cookie|sig)/i;
const BARE_FLAG = /^--?[A-Za-z][A-Za-z0-9-]*$/;
const PACKAGE_SPEC = /^(?:@[A-Za-z0-9][\w.-]*\/)?[A-Za-z0-9][\w.-]*(?:@[\w.^~*-]+)?$/;
const PLAIN_PATH = /^(?:~|\.{1,2})?\/?[\w.-]+(?:\/[\w.-]+)*\/?$/;
const BARE_PROGRAM = /^[A-Za-z0-9][\w.-]*$/;
const VARIABLE_NAME = /^[A-Za-z_][\w-]*$/;

/**
 * Whether an MCP server is plain enough to import. Rakazo stores URLs and arguments in plain
 * text, so this is deliberately conservative rather than a search for secrets: a remote URL
 * with no user info, query or fragment; or a bare program name whose every argument is a bare
 * flag, a package name or a plain path; headers and env by name only. Anything else is skipped
 * and only its name is kept.
 */
export function mcpServerImportable(entry: Record<string, unknown>): boolean {
  const names = (record: unknown) =>
    record === undefined ||
    (isObject(record) && Object.keys(record).every((name) => VARIABLE_NAME.test(name)));
  if (!names(entry.headers) || !names(entry.env)) return false;
  if (typeof entry.url === "string" && entry.url) {
    if (/[?#@]/.test(entry.url)) return false;
    try {
      const url = new URL(entry.url);
      return (url.protocol === "https:" || url.protocol === "http:") && !url.username;
    } catch {
      return false;
    }
  }
  if (typeof entry.command !== "string" || !BARE_PROGRAM.test(entry.command)) return false;
  if (entry.args !== undefined && !Array.isArray(entry.args)) return false;
  return ((entry.args ?? []) as unknown[]).every(
    (arg) =>
      typeof arg === "string" &&
      (BARE_FLAG.test(arg)
        ? !CREDENTIAL_FLAG.test(arg)
        : PACKAGE_SPEC.test(arg) || PLAIN_PATH.test(arg)),
  );
}

/** MCP servers as an import reads them: named fields only, header and env names only. */
function mcpServers(value: unknown): Json {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value).map(([name, server]) => {
      const entry = isObject(server) ? server : {};
      if (!mcpServerImportable(entry)) return [name, { skipped: true }];
      const names = (record: unknown) =>
        isObject(record) ? Object.fromEntries(Object.keys(record).map((key) => [key, ""])) : {};
      const filter = (record: unknown) => {
        if (!isObject(record)) return undefined;
        const list = (items: unknown) =>
          Array.isArray(items) ? items.filter((item) => typeof item === "string") : [];
        return { include: list(record.include), exclude: list(record.exclude) };
      };
      return [
        name,
        {
          ...strings(entry, ["url", "transport", "type", "command"]),
          ...(Array.isArray(entry.args) ? { args: entry.args } : {}),
          ...(typeof entry.enabled === "boolean" ? { enabled: entry.enabled } : {}),
          ...(filter(entry.toolFilter) ? { toolFilter: filter(entry.toolFilter) } : {}),
          ...(filter(entry.tools) ? { tools: filter(entry.tools) } : {}),
          // Only that these exist: an import cannot express them, and they may hold secrets.
          ...(entry.oauth !== undefined || entry.auth !== undefined ? { auth: true } : {}),
          ...(entry.tls !== undefined || entry.cert !== undefined || entry.clientCert !== undefined
            ? { tls: true }
            : {}),
          ...(entry.$include !== undefined ? { $include: true } : {}),
          // A working folder on the source machine is dropped; only that it was set is kept.
          ...(entry.cwd !== undefined && entry.cwd !== "" ? { cwd: true } : {}),
          headers: names(entry.headers),
          env: names(entry.env),
        },
      ];
    }),
  );
}

/** Only the named fields that hold strings: nested objects are never copied. */
function strings(source: Json, keys: readonly string[]): Json {
  return Object.fromEntries(
    keys.filter((key) => typeof source[key] === "string").map((key) => [key, source[key]]),
  );
}

/** A model name as OpenClaw writes it: a string, or `{ primary }`. */
function modelName(value: unknown): Json {
  if (typeof value === "string") return { model: value };
  if (isObject(value) && typeof value.primary === "string")
    return { model: { primary: value.primary } };
  return {};
}

function folderName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) ?? ""
  );
}
