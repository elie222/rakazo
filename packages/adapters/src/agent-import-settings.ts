import type { McpServerConfigInput } from "@rakazo/contracts";
import { isValidTimeZone, McpServerConfigInput as McpServerConfigSchema } from "@rakazo/contracts";
import { nextCronDateAcrossStrict, readAgentImportConfig } from "@rakazo/core";
import { listPiCatalog } from "./pi-models.js";

/**
 * Translates OpenClaw and Hermes settings (model, MCP servers, scheduled jobs, API keys)
 * into Rakazo's inputs. Mirrors what `hermes import-agent openclaw` and `openclaw migrate
 * hermes` carry over, plus scheduled jobs, which those tools only archive.
 */

type Json = Record<string, unknown>;
type Skipped = {
  path: string;
  reason: "builtin" | "unsupported";
};

export type ImportedModel = { title: string; provider: string; modelId: string; known: boolean };
export type ImportedMcpServer = {
  id: string;
  title: string;
  content: string;
  config: McpServerConfigInput;
  allowedTools: string[] | null;
};
export type ImportedRoutine = {
  id: string;
  title: string;
  content: string;
  name: string;
  prompt: string;
  cron: string;
  /** The job's own IANA timezone, when it has one. */
  timezone: string | null;
  active: boolean;
};
export type ImportedApiKey = { id: string; provider: string; title: string; source: string };
export type AgentImportSettings = {
  model: ImportedModel | null;
  mcpServers: ImportedMcpServer[];
  routines: ImportedRoutine[];
  apiKeys: ImportedApiKey[];
  skipped: Skipped[];
};

/** Provider-key variables an import may read; anything else (channel tokens, ...) is ignored. */
const PROVIDER_KEY_VARIABLES: Record<string, string> = {
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

/** Provider names the source tools use for Rakazo's catalog providers. */
const PROVIDER_ALIASES: Record<string, string> = {
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

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

/**
 * Reads the settings of an OpenClaw home or Hermes home. Key values are only read with
 * `includeSecrets`; they are returned separately and never put in a preview.
 */
export function readAgentImportSettings(
  folder: { source: "openclaw" | "hermes"; root: string; files: Map<string, string> },
  options: { includeSecrets: boolean },
): AgentImportSettings & { keyValues: Map<string, string> } {
  const env = options.includeSecrets ? parseDotEnv(folder.files.get(".env") ?? "") : {};
  const configPath = folder.source === "hermes" ? "config.yaml" : "openclaw.json";
  const rawConfig = folder.files.get(configPath);
  const config = rawConfig ? (readAgentImportConfig(configPath, rawConfig) ?? {}) : {};
  const resolve = (value: unknown) => resolveSecret(value, env);
  const skipped: Skipped[] = [];

  const model =
    folder.source === "hermes" ? hermesModel(config) : openClawModel(config, folder.root);

  const mcpServers: ImportedMcpServer[] = [];
  const servers =
    folder.source === "hermes" ? config.mcp_servers : (config.mcp as Json | undefined)?.servers;
  for (const [name, entry] of Object.entries(isObject(servers) ? servers : {})) {
    const server = mcpServer(name, entry, options.includeSecrets ? resolve : null);
    if (server) mcpServers.push({ ...server, id: `mcp:${name}` });
    else skipped.push({ path: `${configPath}: ${name}`, reason: "unsupported" });
  }

  const routines: ImportedRoutine[] = [];
  const jobsFile = folder.files.get("cron/jobs.json");
  const jobs = jobsFile ? readAgentImportConfig("cron/jobs.json", jobsFile)?.jobs : undefined;
  const agentId = /^workspace-(.+)$/.exec(folder.root)?.[1] ?? "main";
  for (const [index, job] of (Array.isArray(jobs) ? jobs : []).entries()) {
    if (!isObject(job)) continue;
    // A job bound to another OpenClaw agent belongs to that agent's import.
    if (text(job.agentId) && text(job.agentId) !== agentId) continue;
    const result = folder.source === "hermes" ? hermesJob(job) : openClawJob(job);
    const label = `cron/jobs.json: ${text(job.name) || text(job.id) || index + 1}`;
    if ("reason" in result) skipped.push({ path: label, reason: result.reason });
    else routines.push({ ...result, id: `routine:${text(job.id) || index}` });
  }

  const keyValues = new Map<string, string>();
  const apiKeys: ImportedApiKey[] = [];
  if (options.includeSecrets) {
    const providers = new Map(listPiCatalog().map((entry) => [entry.provider, entry.providerName]));
    const offer = (provider: string, value: unknown, source: string) => {
      const id = normalizeImportProvider(provider);
      const key = resolve(value);
      if (!key || !providers.has(id) || keyValues.has(id)) return;
      keyValues.set(id, key);
      apiKeys.push({ id: `key:${id}`, provider: id, title: providers.get(id) ?? id, source });
    };
    for (const [provider, entry] of Object.entries(providerConfigs(folder.source, config))) {
      offer(provider, entry, configPath);
    }
    if (folder.source === "hermes") {
      const auth = readAgentImportConfig("auth.json", folder.files.get("auth.json") ?? "") ?? {};
      const pool = isObject(auth.credential_pool) ? auth.credential_pool : {};
      for (const [provider, entries] of Object.entries(pool)) {
        for (const entry of Array.isArray(entries) ? entries : []) {
          // OAuth grants are never imported; only keys the user entered by hand.
          if (isObject(entry) && entry.auth_type === "api_key" && entry.source === "manual") {
            offer(provider, entry.access_token, "auth.json");
          }
        }
      }
    }
    const envVars = folder.source === "openclaw" ? openClawEnv(config) : {};
    for (const [name, value] of [...Object.entries(envVars), ...Object.entries(env)]) {
      const provider = PROVIDER_KEY_VARIABLES[name];
      if (provider) offer(provider, value, name);
    }
  }

  return { model, mcpServers, routines, apiKeys, skipped, keyValues };
}

/** `KEY=value` lines, with optional `export` and quotes; comments and blanks ignored. */
export function parseDotEnv(content: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!match || line.trimStart().startsWith("#")) continue;
    let value = match[2]!;
    const quoted = /^(['"])(.*)\1$/.exec(value);
    value = quoted ? quoted[2]! : value.replace(/\s+#.*$/, "");
    values[match[1]!] = value;
  }
  return values;
}

/**
 * A credential value: a literal, `${VAR}` templates or an env SecretRef, all resolved against
 * the uploaded `.env` only. File, exec and store references cannot be read here.
 */
function resolveSecret(value: unknown, env: Record<string, string>): string | null {
  if (isObject(value)) {
    return value.source === "env" && typeof value.id === "string" ? (env[value.id] ?? null) : null;
  }
  if (typeof value !== "string" || !value.trim()) return null;
  let missing = false;
  const resolved = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => {
    const found = env[name];
    if (found === undefined) missing = true;
    return found ?? "";
  });
  return missing || !resolved.trim() ? null : resolved;
}

function providerConfigs(source: "openclaw" | "hermes", config: Json): Record<string, unknown> {
  if (source === "openclaw") {
    const models = isObject(config.models) ? config.models : {};
    const providers = isObject(models.providers) ? models.providers : {};
    return Object.fromEntries(
      Object.entries(providers).flatMap(([id, entry]) =>
        isObject(entry) && entry.apiKey !== undefined ? [[id, entry.apiKey]] : [],
      ),
    );
  }
  const keys: Record<string, unknown> = {};
  const model = isObject(config.model) ? config.model : {};
  if (text(model.provider) && model.api_key !== undefined)
    keys[text(model.provider)] = model.api_key;
  for (const [name, entry] of Object.entries(isObject(config.providers) ? config.providers : {})) {
    if (isObject(entry) && entry.api_key !== undefined) keys[name] ??= entry.api_key;
  }
  for (const entry of Array.isArray(config.custom_providers) ? config.custom_providers : []) {
    if (isObject(entry) && text(entry.name) && entry.api_key !== undefined) {
      keys[text(entry.name)] ??= entry.api_key;
    }
  }
  return keys;
}

/** OpenClaw `env.vars` and plain string entries directly under `env`. */
function openClawEnv(config: Json): Record<string, unknown> {
  const env = isObject(config.env) ? config.env : {};
  const vars = isObject(env.vars) ? env.vars : {};
  const direct = Object.entries(env).filter(([, value]) => typeof value === "string");
  return { ...Object.fromEntries(direct), ...vars };
}

function catalogModel(title: string, provider: string, modelId: string): ImportedModel {
  const id = normalizeImportProvider(provider);
  const known = listPiCatalog().some((entry) => entry.provider === id && entry.id === modelId);
  return { title, provider: id, modelId, known };
}

/** The chosen agent's model: its own entry overrides `agents.defaults.model`. */
function openClawModel(config: Json, root: string): ImportedModel | null {
  const agents = isObject(config.agents) ? config.agents : {};
  const agentId = /^workspace-(.+)$/.exec(root)?.[1] ?? "main";
  const entries = [
    ...Object.entries(isObject(agents.entries) ? agents.entries : {}).map(([id, entry]) => ({
      id,
      ...(isObject(entry) ? entry : {}),
    })),
    ...(Array.isArray(agents.list) ? agents.list.filter(isObject) : []),
  ] as Json[];
  const own = entries.find(
    (entry) =>
      entry.id === agentId ||
      (typeof entry.workspace === "string" && folderName(entry.workspace) === root),
  );
  const defaults = isObject(agents.defaults) ? agents.defaults : {};
  const value = own?.model ?? defaults.model;
  const name = isObject(value) ? text(value.primary) : text(value);
  const slash = name.indexOf("/");
  if (slash <= 0 || slash === name.length - 1) return null;
  return catalogModel(name, name.slice(0, slash), name.slice(slash + 1));
}

function hermesModel(config: Json): ImportedModel | null {
  const model = isObject(config.model) ? config.model : {};
  const modelId = text(model.default) || text(model.model);
  const provider = text(model.provider);
  if (!modelId || !provider) return null;
  return catalogModel(`${provider}/${modelId}`, provider, modelId);
}

function folderName(path: string): string {
  return (
    path
      .replace(/[\\/]+$/, "")
      .split(/[\\/]/)
      .at(-1) ?? ""
  );
}

function mcpServer(
  name: string,
  entry: unknown,
  resolve: ((value: unknown) => string | null) | null,
): Omit<ImportedMcpServer, "id"> | null {
  if (!isObject(entry)) return null;
  // OAuth, client certificates and `$include` have no import equivalent.
  for (const key of ["auth", "oauth", "tls", "cert", "clientCert", "$include"]) {
    if (entry[key] !== undefined && entry[key] !== false) return null;
  }
  const filter = isObject(entry.toolFilter)
    ? entry.toolFilter
    : isObject(entry.tools)
      ? entry.tools
      : {};
  // Rakazo only lists allowed tools; dropping an exclusion would grant more than the source.
  if (Array.isArray(filter.exclude) && filter.exclude.length > 0) return null;
  const allowedTools = Array.isArray(filter.include)
    ? filter.include.filter((tool): tool is string => typeof tool === "string")
    : null;
  // Credential values come only with the API key opt-in; otherwise the server is created
  // without them and shows as needing credentials, like a server added without auth.
  const values = (record: unknown): Record<string, string> | null => {
    if (!resolve || !isObject(record)) return {};
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(record)) {
      const resolved = resolve(value);
      if (resolved === null) return null;
      out[key] = resolved;
    }
    return out;
  };
  const names = (record: unknown) => (isObject(record) ? Object.keys(record) : []);
  const base = {
    slug: mcpSlug(name),
    name: name.slice(0, 120),
    description: "",
    enabled: entry.enabled !== false,
  };
  let candidate: unknown;
  let content: string;
  if (text(entry.url)) {
    const headers = values(entry.headers);
    if (!headers) return null;
    const kind = `${text(entry.transport)}${text(entry.type)}`.toLowerCase();
    candidate = {
      ...base,
      transport: kind.includes("sse") ? "sse" : "streamable_http",
      endpoint: text(entry.url),
      headers,
    };
    content = [text(entry.url), ...names(entry.headers)].join("\n");
  } else if (text(entry.command)) {
    const env = values(entry.env);
    if (!env) return null;
    const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
    candidate = { ...base, transport: "stdio", command: text(entry.command), args, env };
    content = [[text(entry.command), ...args].join(" "), ...names(entry.env)].join("\n");
  } else {
    return null;
  }
  const parsed = McpServerConfigSchema.safeParse(candidate);
  if (!parsed.success) return null;
  return { title: name, content, config: parsed.data, allowedTools };
}

/** An MCP slug: lowercase letters, digits, `-` and `_`, starting with a letter or digit. */
export function mcpSlug(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^[-_]+/, "")
    .slice(0, 64)
    .replace(/[-_]+$/, "");
  return slug || "mcp";
}

type JobResult = Omit<ImportedRoutine, "id"> | { reason: Skipped["reason"] };

function openClawJob(job: Json): JobResult {
  const payload = isObject(job.payload) ? job.payload : {};
  const message = text(payload.message);
  // OpenClaw keeps its own heartbeat and memory jobs in the same list.
  if (job.declarationKey || payload.kind !== "agentTurn" || message.startsWith("__openclaw")) {
    return { reason: "builtin" };
  }
  const schedule = isObject(job.schedule) ? job.schedule : {};
  const cron =
    schedule.kind === "cron"
      ? text(schedule.expr)
      : schedule.kind === "every" && typeof schedule.everyMs === "number"
        ? intervalCron(schedule.everyMs / 60_000)
        : null;
  return routine(job, message, cron, text(schedule.tz));
}

function hermesJob(job: Json): JobResult {
  if (text(job.script) || job.no_agent === true) return { reason: "unsupported" };
  const schedule = isObject(job.schedule) ? job.schedule : {};
  const cron =
    schedule.kind === "cron"
      ? text(schedule.expr)
      : schedule.kind === "interval" && typeof schedule.minutes === "number"
        ? intervalCron(schedule.minutes)
        : null;
  return routine(job, text(job.prompt), cron, "");
}

function routine(job: Json, prompt: string, cron: string | null, tz: string): JobResult {
  const name = (text(job.name) || text(job.displayName) || "Routine").slice(0, 80);
  if (!prompt || !cron || !validCron(cron)) return { reason: "unsupported" };
  const timezone = tz && isValidTimeZone(tz) ? tz : null;
  return {
    title: name,
    name,
    prompt,
    cron,
    timezone,
    active: job.enabled !== false,
    content: `${cron}${timezone ? ` (${timezone})` : ""}\n\n${prompt}`,
  };
}

/**
 * A repeat interval as a cron expression when one fires at exactly that interval: minutes
 * that divide an hour, or hours that divide a day. Anything else has no exact cron.
 */
export function intervalCron(minutes: number): string | null {
  if (!Number.isInteger(minutes) || minutes <= 0) return null;
  if (minutes < 60) return 60 % minutes === 0 ? `*/${minutes} * * * *` : null;
  if (minutes % 60 !== 0) return null;
  const hours = minutes / 60;
  if (hours === 24) return "0 0 * * *";
  return hours < 24 && 24 % hours === 0 ? `0 */${hours} * * *` : null;
}

function validCron(cron: string): boolean {
  try {
    return nextCronDateAcrossStrict([cron], new Date(), "UTC") !== null;
  } catch {
    return false;
  }
}
