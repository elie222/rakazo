import { resolveAuthSecret, resolveEncryptionKey, resolveSupervisorToken } from "@rakazo/core";

export interface AppEnv {
  databaseUrl: string;
  realtimeDatabaseUrl: string;
  authSecret: string;
  authUrl: string;
  webOrigin: string;
  apiUrl: string;
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
  encryptionKey: string;
  dataDir: string;
  sandboxSupervisorUrl: string;
  sandboxSupervisorToken: string;
  sandboxProvider: string;
  agentRuntime: string;
  openRouterKey: string | undefined;
  e2bApiKey: string | undefined;
  composioApiKey: string | undefined;
  defaultProvider: string;
  defaultModel: string;
  wakeupDriver: string;
  port: number;
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  const authSecret = resolveAuthSecret(source);
  return {
    databaseUrl: required(source, "DATABASE_URL"),
    realtimeDatabaseUrl: source.REALTIME_DATABASE_URL ?? required(source, "DATABASE_URL"),
    authSecret,
    authUrl: source.BETTER_AUTH_URL ?? source.WEB_ORIGIN ?? "http://127.0.0.1:5173",
    webOrigin: source.WEB_ORIGIN ?? "http://127.0.0.1:5173",
    apiUrl: source.API_URL ?? "http://127.0.0.1:3100",
    signupsEnabled: source.SIGNUPS_ENABLED,
    signupAllowlist: source.SIGNUP_ALLOWLIST,
    encryptionKey: resolveEncryptionKey(source),
    dataDir: source.DATA_DIR ?? "./data",
    sandboxSupervisorUrl: source.SANDBOX_SUPERVISOR_URL ?? "http://127.0.0.1:7091",
    sandboxSupervisorToken: resolveSupervisorToken(source),
    sandboxProvider: source.SANDBOX_PROVIDER ?? "docker",
    agentRuntime: source.AGENT_RUNTIME ?? "pi",
    openRouterKey: source.OPENROUTER_API_KEY,
    e2bApiKey: source.E2B_API_KEY,
    composioApiKey: source.COMPOSIO_API_KEY,
    defaultProvider: source.PI_DEFAULT_PROVIDER ?? "openrouter",
    defaultModel: source.PI_DEFAULT_MODEL ?? "deepseek/deepseek-v4-flash-0731",
    wakeupDriver: source.WAKEUP_DRIVER ?? "graphile",
    port: Number(source.API_PORT ?? 3100),
  };
}

function required(source: NodeJS.ProcessEnv, key: string): string {
  const value = source[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}
