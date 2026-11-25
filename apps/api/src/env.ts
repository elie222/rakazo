import { readFileSync } from "node:fs";
import type { WorkspaceExportLimits } from "@rakazo/adapter-kit";
import type {
  ApnsVoipConfig,
  MessagingEnvironmentValues,
  SandboxProviderOptions,
} from "@rakazo/adapters";
import {
  absoluteHttpOrigin,
  apnsVoipConfig,
  autoReviewMinConfidence,
  deploymentLabsFromEnv,
  inboundOrigin,
  liveModelCatalogEnabled,
  mcpStdioOptionsFromEnv,
  messagingEnvFromProcess,
  openAiCompatAllowPublicHosts,
  resolveCloudAgentProvider,
  resolveDeploymentModel,
  resolveSandboxProvider,
  sandboxProviderOptionsFromEnv,
  secretStoreOptionsFromEnv,
  webOriginFromEnv,
  workspaceSaveLimits,
} from "@rakazo/adapters";
import type { OidcConfig, SocialAuthConfig } from "@rakazo/auth";
import { oidcAuthorizationParams, socialAuthFromFields } from "@rakazo/auth";
import type { LabFeature, MinimumClientBuilds, NavLink } from "@rakazo/contracts";
import { isPrivateNetworkHost, parseMinimumClientBuilds, parseNavLinks } from "@rakazo/contracts";
import { parseCrispWebsiteId } from "@rakazo/contracts/content-security-policy";
import {
  attachmentCountFromEnv,
  parseEnvFlag,
  phoneCallSettings,
  SIGNUPS_ENABLED_VALUES,
  uploadSizeFromEnv,
} from "@rakazo/core";
import {
  MAX_SANDBOX_COMMAND_TIMEOUT_MS,
  sandboxCommandTimeoutExceedsMax,
} from "@rakazo/core/node/sandbox-command";
import {
  resolveAuthSecret,
  resolveContentEncryption,
  resolveEncryptionKey,
  resolveScreenProxySecret,
  resolveSupervisorToken,
} from "@rakazo/core/node/secrets-guard";
import { getLogger, monitoringPseudonymSecret } from "@rakazo/logging";
import type { DeploymentVoice } from "./voice/deployment-config.js";
import { deploymentVoiceFromEnv } from "./voice/deployment-config.js";

export { resolveCloudAgentProvider, resolveSandboxProvider } from "@rakazo/adapters";

export interface AppEnv extends MessagingEnvironmentValues {
  deploymentVoice?: DeploymentVoice;
  passwordAuth?: boolean;
  /** Opt-in Have I Been Pwned check for new passwords. Default off: it calls an outside service. */
  breachedPasswordCheck?: boolean;
  oidc?: OidcConfig;
  /** Google and Apple sign-in. Absent when neither provider is configured. */
  social?: SocialAuthConfig;
  /** Bearer token the identity provider presents to provision accounts over SCIM. */
  scimBearerToken?: string;
  nodeEnv: string;
  desktopStackToken?: string;
  databaseUrl: string;
  realtimeDatabaseUrl: string;
  authSecret: string;
  authUrl: string;
  webOrigin: string;
  /** Extra browser origins trusted for sign-in and CORS, from `RAKAZO_EXTRA_AUTH_ORIGINS`. */
  extraAuthOrigins: string[];
  /** `<TEAM_ID>.<bundle id>` of iOS apps that may use this domain's passkeys. */
  passkeyAppleAppIds: string[];
  /** SHA-256 signing certificate fingerprints of Android apps that may use this domain's passkeys. */
  passkeyAndroidCertFingerprints: string[];
  privacyPolicyUrl?: string;
  apiUrl: string;
  /** The public origin outside services post webhooks to, when an ingress provider publishes one. */
  publishedInboundOrigin?: string;
  apiHost: string;
  /** Proxies whose forwarded client address is believed; empty means local networks. */
  trustedProxies: string[];
  clientIpHeader: string;
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
  encryptionKey: string;
  contentEncryption: boolean;
  dataDir: string;
  /** Opt-in Pi JSONL session recording under DATA_DIR/pi-sessions. Default off. */
  piSessionRecording: boolean;
  /** Labs features this deployment turns on for every account. */
  deploymentLabs: LabFeature[];
  /** USER_DEVICES_ENABLED=false stops users connecting their own computers. Default on. */
  userDevicesEnabled: boolean;
  /** COMPUTER_SETTINGS_ENABLED=true lets Settings choose where computers run. Default off. */
  computerSettingsEnabled: boolean;
  /** Operator menu links that frame a same-origin page (RAKAZO_NAV_LINKS). */
  navLinks?: NavLink[];
  /** Verified accounts that review plugin submissions, add stdio MCP servers, and grant access
   * (RAKAZO_ADMIN_EMAILS), lowercased. */
  adminEmails: string[];
  phoneCallsEnabled: boolean;
  phoneCallRingSeconds: number;
  phoneCallCooldownMinutes: number;
  maxUploadSizeBytes: number;
  /** What one computer save may copy; the worker reads the same setting. */
  workspaceSaveLimits: WorkspaceExportLimits;
  maxAttachmentsPerMessage: number;
  /** Bot replies longer than this are read aloud as a summary; unset reads every reply in full. */
  voiceSummaryMinChars: number | undefined;
  sandboxSupervisorUrl: string;
  sandboxSupervisorToken: string | undefined;
  screenProxySecret: string;
  sandboxProvider: string;
  cloudAgentProvider: string;
  cloudAgentSpaceId: string | undefined;
  cursorApiKey: string | undefined;
  /** Raw PAYMENT_WALLET_* values; createPaymentWalletProvider resolves them. */
  paymentWalletProvider: string | undefined;
  paymentWalletClientId: string | undefined;
  agentRuntime: string;
  deploymentModelKey: string | undefined;
  /** The deployment default model can run; see resolveDeploymentModel. */
  deploymentModelConfigured: boolean;
  /** The deployment default model runs on the host's credentials rather than a key. */
  deploymentModelHostCredentials: boolean;
  /** Every computer provider's options, read through the provider's own environment bindings. */
  sandboxOptions: SandboxProviderOptions;
  composioApiKey: string | undefined;
  /** Optional integrations.sh-compatible catalog base URL. */
  integrationsCatalogUrl: string | undefined;
  pipedreamClientId: string | undefined;
  pipedreamClientSecret: string | undefined;
  pipedreamProjectId: string | undefined;
  pipedreamEnvironment: "development" | "production";
  expoAccessToken: string | undefined;
  apnsVoip?: ApnsVoipConfig;
  smtpUrl: string | undefined;
  botEmailSmtpUrl?: string;
  emailProvider?: string;
  emailApiKey?: string;
  emailFrom: string | undefined;
  emailReplyTo?: string;
  /** Mail to bots' addresses, posted by a relay; off unless the domain and secret are both set. */
  inboundEmail?: { domain: string; secret: string };
  /** Billing turns on only when all three are set; self-hosted installs leave them unset. */
  stripeSecretKey: string | undefined;
  stripeWebhookSecret: string | undefined;
  stripePriceId: string | undefined;
  /** Reports signups and plan payments to the affiliate program; off when unset. */
  dubApiKey: string | undefined;
  emailEmulator: boolean;
  billingEmulator: boolean;
  /** A/B tests this deployment runs, by key; none by default. */
  experiments: string | undefined;
  slackClientId?: string;
  slackClientSecret?: string;
  /** Unknown chat senders auto-provision their own accounts when true. */
  messagingOpenSignup: boolean;
  /** Bot that owns team/external chat rooms on the messaging surface. */
  teamChatBotId: string | undefined;
  /** Optional model override for ambient engagement judging. */
  teamChatJudgeProvider: string | undefined;
  teamChatJudgeModel: string | undefined;
  defaultProvider: string;
  defaultModel: string;
  wakeupDriver: string;
  mcpStdioEnabled: boolean;
  mcpStdioAllowedCommands: string[];
  mcpStdio: ReturnType<typeof mcpStdioOptionsFromEnv>;
  /** Deployment-owner escape for remote MCP on RFC1918 / Docker-network hosts. */
  mcpAllowPrivateEndpoint: boolean;
  port: number;
  gitSha: string | undefined;
  /** Oldest client build per kind the API still serves (RAKAZO_MIN_CLIENT_BUILD). */
  minimumClientBuilds?: MinimumClientBuilds;
  /** Browser error reporting, served to the web app at runtime. The DSN is public by design. */
  browserMonitoring:
    | { dsn: string; environment?: string; release?: string; pseudonymSecret?: string }
    | undefined;
  /** Crisp chat on the paywall, for the hosted service; self-hosted installs leave it unset. */
  crispWebsiteId?: string | null;
  /** DEMO_ACCOUNT_EMAIL and DEMO_ACCOUNT_PASSWORD, published to sign-in; only for throwaway demo servers. */
  demoAccount?: { email: string; password: string } | null;
}

/** Overrides win key by key inside `sandboxOptions`, so a partial one keeps the rest of the environment's. */
export function withEnvOverrides(env: AppEnv, overrides: Partial<AppEnv>): AppEnv {
  return {
    ...env,
    ...overrides,
    sandboxOptions: { ...env.sandboxOptions, ...overrides.sandboxOptions },
  };
}

export function loadEnv(source: NodeJS.ProcessEnv = process.env): AppEnv {
  secretStoreOptionsFromEnv(source);
  if (sandboxCommandTimeoutExceedsMax(source)) {
    getLogger().warn("SANDBOX_COMMAND_TIMEOUT_MS is above the maximum; using the maximum", {
      maximumMs: MAX_SANDBOX_COMMAND_TIMEOUT_MS,
    });
  }
  const issuer = optional(source.OIDC_ISSUER);
  const clientId = optional(source.OIDC_CLIENT_ID);
  const clientSecret = optional(source.OIDC_CLIENT_SECRET);
  const credentials = [issuer, clientId, clientSecret];
  if (credentials.some(Boolean) && !credentials.every(Boolean)) {
    throw new Error(
      "OIDC_ISSUER, OIDC_CLIENT_ID and OIDC_CLIENT_SECRET must be configured together",
    );
  }
  if (issuer) {
    try {
      const url = new URL(issuer);
      if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
        throw new Error();
    } catch {
      throw new Error("OIDC_ISSUER must be an HTTPS issuer URL");
    }
  }
  for (const key of [
    "AUTH_PASSWORD_ENABLED",
    "AUTH_BREACHED_PASSWORD_CHECK_ENABLED",
    "OIDC_ALLOW_SIGNUP_BYPASS",
  ]) {
    const value = source[key];
    if (value && !["true", "false"].includes(value))
      throw new Error(`${key} must be true or false`);
  }
  // A typo that read as "open" would expose registration, so refuse anything unrecognized.
  // Empty means unset, as before.
  const signupsEnabled = source.SIGNUPS_ENABLED?.trim().toLowerCase();
  if (signupsEnabled && !(SIGNUPS_ENABLED_VALUES as readonly string[]).includes(signupsEnabled))
    throw new Error("SIGNUPS_ENABLED must be true or false");
  // Same for the model endpoint switch: read at request time, so refuse a bad value at boot.
  openAiCompatAllowPublicHosts(source);
  // Fail at boot rather than on the first review, which would quietly ask every time.
  autoReviewMinConfidence(source);
  liveModelCatalogEnabled(source);
  const passwordAuth = source.AUTH_PASSWORD_ENABLED !== "false";
  if (!passwordAuth && !issuer)
    throw new Error("AUTH_PASSWORD_ENABLED=false requires OIDC configuration");
  const oidc =
    issuer && clientId && clientSecret
      ? {
          issuer,
          clientId,
          clientSecret,
          name: optional(source.OIDC_NAME) ?? "SSO",
          scopes: (optional(source.OIDC_SCOPES) ?? "openid email profile")
            .split(/[\s,]+/)
            .filter(Boolean),
          allowSignupBypass: source.OIDC_ALLOW_SIGNUP_BYPASS === "true",
          emailVerifiedClaim: optional(source.OIDC_EMAIL_VERIFIED_CLAIM),
          authorizationParams: oidcAuthorizationParams(source.OIDC_AUTHORIZATION_PARAMS),
        }
      : undefined;
  const social = socialAuthFromFields({
    googleClientId: optional(source.GOOGLE_CLIENT_ID),
    googleClientSecret: optional(source.GOOGLE_CLIENT_SECRET),
    appleClientId: optional(source.APPLE_CLIENT_ID),
    appleTeamId: optional(source.APPLE_TEAM_ID),
    appleKeyId: optional(source.APPLE_KEY_ID),
    applePrivateKey: applePrivateKey(source),
  });
  const scimBearerToken = optional(source.SCIM_BEARER_TOKEN);
  if (scimBearerToken && (scimBearerToken.length < 32 || /\s/.test(scimBearerToken)))
    throw new Error("SCIM_BEARER_TOKEN must be at least 32 characters with no spaces");
  const authSecret = resolveAuthSecret(source);
  const webOrigin = webOriginFromEnv(source);
  const sandboxProvider = resolveSandboxProvider(source);
  const cloudAgentProvider = resolveCloudAgentProvider(source);
  const deploymentModel = resolveDeploymentModel(source);
  let sandboxOptions: SandboxProviderOptions | undefined;
  return {
    passwordAuth,
    breachedPasswordCheck: source.AUTH_BREACHED_PASSWORD_CHECK_ENABLED === "true",
    oidc,
    social,
    scimBearerToken,
    nodeEnv: source.NODE_ENV ?? "",
    databaseUrl: required(source, "DATABASE_URL"),
    realtimeDatabaseUrl: source.REALTIME_DATABASE_URL ?? required(source, "DATABASE_URL"),
    desktopStackToken: optional(source.RAKAZO_DESKTOP_STACK_TOKEN),
    authSecret,
    authUrl: absoluteHttpOrigin(source.BETTER_AUTH_URL, webOrigin, "BETTER_AUTH_URL"),
    webOrigin,
    extraAuthOrigins: parseExtraAuthOrigins(source.RAKAZO_EXTRA_AUTH_ORIGINS),
    passkeyAppleAppIds: list(source.PASSKEY_APPLE_APP_IDS),
    passkeyAndroidCertFingerprints: androidCertFingerprints(source.PASSKEY_ANDROID_CERT_SHA256),
    privacyPolicyUrl: optional(source.PRIVACY_POLICY_URL),
    ...messagingEnvFromProcess(source),
    apiUrl: source.API_URL ?? "http://127.0.0.1:3100",
    publishedInboundOrigin: inboundOrigin(source),
    apiHost: source.API_HOST ?? "127.0.0.1",
    trustedProxies: (source.TRUSTED_PROXIES ?? "")
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean),
    clientIpHeader: optional(source.CLIENT_IP_HEADER)?.toLowerCase() ?? "x-forwarded-for",
    signupsEnabled: source.SIGNUPS_ENABLED,
    signupAllowlist: source.SIGNUP_ALLOWLIST,
    encryptionKey: resolveEncryptionKey(source),
    contentEncryption: resolveContentEncryption(source),
    dataDir: source.DATA_DIR ?? "./data",
    piSessionRecording: source.PI_SESSION_RECORDING === "true",
    deploymentLabs: deploymentLabsFromEnv(source),
    userDevicesEnabled: parseEnvFlag("USER_DEVICES_ENABLED", source.USER_DEVICES_ENABLED, true),
    computerSettingsEnabled: source.COMPUTER_SETTINGS_ENABLED === "true",
    navLinks: parseNavLinks(source.RAKAZO_NAV_LINKS),
    adminEmails: list(source.RAKAZO_ADMIN_EMAILS).map((email) => email.toLowerCase()),
    ...phoneCallSettings(source),
    maxUploadSizeBytes: uploadSizeFromEnv(source),
    workspaceSaveLimits: workspaceSaveLimits(source),
    maxAttachmentsPerMessage: attachmentCountFromEnv(source),
    deploymentVoice: deploymentVoiceFromEnv(
      source.DEPLOYMENT_VOICE,
      source.MCP_ALLOW_PRIVATE_ENDPOINT === "true",
    ),
    voiceSummaryMinChars: voiceSummaryMinCharsFromEnv(source.VOICE_SUMMARY_MIN_CHARS),
    sandboxSupervisorUrl: source.SANDBOX_SUPERVISOR_URL ?? "http://127.0.0.1:7091",
    sandboxSupervisorToken:
      sandboxProvider === "docker" ? resolveSupervisorToken(source) : undefined,
    screenProxySecret: resolveScreenProxySecret(source),
    sandboxProvider,
    cloudAgentProvider,
    cloudAgentSpaceId: optional(source.CLOUD_AGENT_SPACE_ID),
    cursorApiKey: optional(source.CURSOR_API_KEY),
    paymentWalletProvider: optional(source.PAYMENT_WALLET_PROVIDER),
    paymentWalletClientId: optional(source.PAYMENT_WALLET_CLIENT_ID),
    agentRuntime: source.AGENT_RUNTIME ?? "pi",
    // Provider, model and key resolve together: see resolveDeploymentModel.
    deploymentModelKey: deploymentModel.key,
    deploymentModelConfigured: deploymentModel.configured,
    deploymentModelHostCredentials: deploymentModel.hostCredentials,
    // Read on first use, so a malformed computer setting stops only the services that build one.
    get sandboxOptions() {
      sandboxOptions ??= sandboxProviderOptionsFromEnv(source);
      return sandboxOptions;
    },
    composioApiKey: source.COMPOSIO_API_KEY,
    integrationsCatalogUrl: optional(source.INTEGRATIONS_CATALOG_URL),
    pipedreamClientId: optional(source.PIPEDREAM_CLIENT_ID),
    pipedreamClientSecret: optional(source.PIPEDREAM_CLIENT_SECRET),
    pipedreamProjectId: optional(source.PIPEDREAM_PROJECT_ID),
    pipedreamEnvironment:
      source.PIPEDREAM_ENVIRONMENT === "production" ? "production" : "development",
    expoAccessToken: optional(source.EXPO_ACCESS_TOKEN),
    apnsVoip: apnsVoipConfig(source),
    smtpUrl: optional(source.SMTP_URL),
    botEmailSmtpUrl: optional(source.BOT_EMAIL_SMTP_URL),
    emailProvider: optional(source.EMAIL_PROVIDER),
    emailApiKey: optional(source.EMAIL_API_KEY),
    emailFrom: optional(source.EMAIL_FROM),
    emailReplyTo: optional(source.EMAIL_REPLY_TO),
    inboundEmail: inboundEmailFromEnv(source),
    stripeSecretKey: optional(source.STRIPE_SECRET_KEY),
    stripeWebhookSecret: optional(source.STRIPE_WEBHOOK_SECRET),
    stripePriceId: optional(source.STRIPE_PRICE_ID),
    dubApiKey: optional(source.DUB_API_KEY),
    emailEmulator: source.EMAIL_EMULATOR === "true" && source.NODE_ENV !== "production",
    experiments: optional(source.EXPERIMENTS),
    billingEmulator: source.BILLING_EMULATOR === "true" && source.NODE_ENV !== "production",
    slackClientId: optional(source.SLACK_CLIENT_ID),
    slackClientSecret: optional(source.SLACK_CLIENT_SECRET),
    messagingOpenSignup: source.MESSAGING_OPEN_SIGNUP === "true",
    teamChatBotId: optional(source.TEAM_CHAT_BOT_ID) ?? optional(source.SLACK_RAKAZO_BOT_ID),
    teamChatJudgeProvider: optional(source.TEAM_CHAT_JUDGE_PROVIDER),
    teamChatJudgeModel: optional(source.TEAM_CHAT_JUDGE_MODEL),
    defaultProvider: deploymentModel.provider,
    defaultModel: deploymentModel.model,
    wakeupDriver: source.WAKEUP_DRIVER ?? "graphile",
    mcpStdioEnabled: source.MCP_STDIO_ENABLED === "true",
    mcpStdioAllowedCommands: (source.MCP_STDIO_ALLOWED_COMMANDS ?? "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
    mcpStdio: mcpStdioOptionsFromEnv(source),
    mcpAllowPrivateEndpoint: source.MCP_ALLOW_PRIVATE_ENDPOINT === "true",
    port: Number(source.API_PORT ?? 3100),
    gitSha: optional(source.GIT_SHA) ?? optional(source.RAKAZO_GIT_SHA),
    minimumClientBuilds: parseMinimumClientBuilds(source.RAKAZO_MIN_CLIENT_BUILD),
    browserMonitoring: browserMonitoringFromEnv(source),
    crispWebsiteId: parseCrispWebsiteId(source.CRISP_WEBSITE_ID),
    demoAccount: demoAccountFromEnv(source),
  };
}

/**
 * Comma-separated origins an operator adds for a second address of the same install (a tailnet
 * or LAN URL). Only bare `https://` origins, or `http://` on loopback or a private network, are
 * kept; anything else is dropped with a warning so a typo cannot widen trust.
 */
export function parseExtraAuthOrigins(value: string | undefined): string[] {
  const origins = new Set<string>();
  for (const raw of (value ?? "").split(/[\s,]+/).filter(Boolean)) {
    try {
      const url = new URL(raw);
      const bare =
        url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password;
      const allowed =
        url.protocol === "https:" ||
        (url.protocol === "http:" && isPrivateNetworkHost(url.hostname));
      if (!bare || !allowed) throw new Error();
      origins.add(url.origin);
    } catch {
      // The entry is not logged: it may carry credentials.
      getLogger().warn("ignoring invalid RAKAZO_EXTRA_AUTH_ORIGINS entry");
    }
  }
  return [...origins];
}

function required(source: NodeJS.ProcessEnv, key: string): string {
  const value = source[key];
  if (!value) throw new Error(`Missing ${key}`);
  return value;
}

function browserMonitoringFromEnv(source: NodeJS.ProcessEnv): AppEnv["browserMonitoring"] {
  const dsn = optional(source.SENTRY_BROWSER_DSN);
  if (!dsn) return undefined;
  const sha = optional(source.GIT_SHA);
  return {
    dsn,
    environment: optional(source.SENTRY_ENVIRONMENT),
    release: optional(source.SENTRY_RELEASE) ?? (sha === "unknown" ? undefined : sha),
    pseudonymSecret: monitoringPseudonymSecret(source),
  };
}

function voiceSummaryMinCharsFromEnv(value: string | undefined): number | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) === 0) {
    throw new Error("VOICE_SUMMARY_MIN_CHARS must be a positive whole number of characters");
  }
  return Number(raw);
}

function inboundEmailFromEnv(source: NodeJS.ProcessEnv): AppEnv["inboundEmail"] {
  const domain = optional(source.INBOUND_EMAIL_DOMAIN)?.toLowerCase();
  const secret = optional(source.INBOUND_EMAIL_SECRET);
  if (!domain && !secret) return undefined;
  if (!domain || !secret) {
    throw new Error("Set INBOUND_EMAIL_DOMAIN and INBOUND_EMAIL_SECRET together");
  }
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw new Error("INBOUND_EMAIL_DOMAIN must be a domain name such as bots.example.com");
  }
  if (secret.length < 32) throw new Error("INBOUND_EMAIL_SECRET must be at least 32 characters");
  return { domain, secret };
}

function applePrivateKey(source: NodeJS.ProcessEnv): string | undefined {
  const inline = optional(source.APPLE_PRIVATE_KEY);
  const file = optional(source.APPLE_PRIVATE_KEY_FILE);
  if (inline && file) throw new Error("Set APPLE_PRIVATE_KEY or APPLE_PRIVATE_KEY_FILE, not both");
  if (!file) return inline;
  try {
    return readFileSync(file, "utf8");
  } catch (cause) {
    throw new Error("APPLE_PRIVATE_KEY_FILE could not be read", { cause });
  }
}

function optional(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function list(value: string | undefined): string[] {
  return (value ?? "").split(/[\s,]+/).filter(Boolean);
}

/** SHA-256 signing certificate fingerprints, normalized to the `AA:BB:…` form Digital Asset Links uses. */
function androidCertFingerprints(value: string | undefined): string[] {
  return list(value).map((fingerprint) => {
    const hex = fingerprint.replace(/:/g, "");
    if (!/^[0-9a-f]{64}$/i.test(hex)) {
      throw new Error("PASSKEY_ANDROID_CERT_SHA256 must list SHA-256 fingerprints");
    }
    return hex.toUpperCase().match(/../g)!.join(":");
  });
}

function demoAccountFromEnv(source: NodeJS.ProcessEnv) {
  const email = optional(source.DEMO_ACCOUNT_EMAIL);
  const password = source.DEMO_ACCOUNT_PASSWORD;
  return email && password ? { email, password } : null;
}
