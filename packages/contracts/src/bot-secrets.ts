import { z } from "zod";
import { AGENT_SECRET_NAME_PATTERN } from "./agent-secret-name.js";
import { Id } from "./ids.js";

// An opaque reference handle: matched exactly by secret_request/forget_secret,
// displayed in list_secrets. Never interpolated into shells, env, or URLs, so
// hyphens are safe.
export const BotSecretName = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

// A name read back from storage. It is deliberately looser than BotSecretName so a row saved
// before the pattern tightened stays listable and removable instead of failing a whole list call.
export const StoredBotSecretName = z.string().min(1).max(256);

const SecretHeaderName = z
  .string()
  .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,120}$/)
  .refine(
    (name) =>
      !/^(host|connection|content-length|content-type|transfer-encoding|te|trailer|upgrade|cookie|origin|referer|accept|proxy-.*|sec-.*|.*forwarded.*)$/i.test(
        name,
      ),
    "Unsupported credential header",
  );

export const BotSecretAuth = z.discriminatedUnion("type", [
  z.object({ type: z.literal("bearer") }),
  z.object({ type: z.literal("header"), name: SecretHeaderName }),
  z.object({
    type: z.literal("basic"),
    username: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^:\r\n]+$/),
  }),
  // A website sign-in. The username and password are both protected; the backend only types
  // them into pages on the saved origin and never sends them as HTTP credentials.
  z.object({ type: z.literal("login") }),
  // A value exported to this bot's shell commands as an environment variable. It has no site.
  z.object({ type: z.literal("command") }),
]);

// Names that change how shells and common runtimes start, where they load code from, or how
// they reach the network. A bot's command variable must never override them. The list is not
// exhaustive: it covers the well-known variables, and the prefix rules below catch whole
// families. Treat an unlisted name as allowed, not as proof it is harmless.
const RESERVED_COMMAND_VARIABLE_NAMES = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "PWD",
  "OLDPWD",
  "TERM",
  "IFS",
  "ENV",
  "BASH_ENV",
  "BASHOPTS",
  "SHELLOPTS",
  "CDPATH",
  "GLOBIGNORE",
  "PROMPT_COMMAND",
  "PS4",
  "TMPDIR",
  "DISPLAY",
  "XAUTHORITY",
  "SSH_AUTH_SOCK",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PYTHONPATH",
  "PYTHONHOME",
  "PYTHONSTARTUP",
  "PERL5LIB",
  "PERL5OPT",
  "RUBYOPT",
  "JAVA_TOOL_OPTIONS",
  "JDK_JAVA_OPTIONS",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "NO_PROXY",
  // TLS trust: these redirect which certificates common clients accept, or disable the check.
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "SSLKEYLOGFILE",
  "REQUESTS_CA_BUNDLE",
  "CURL_CA_BUNDLE",
  "NODE_EXTRA_CA_CERTS",
  "NODE_TLS_REJECT_UNAUTHORIZED",
  "GIT_SSL_CAINFO",
  "GIT_SSL_NO_VERIFY",
  // OpenSSL config, engine, and module paths can load attacker-controlled code.
  "OPENSSL_CONF",
  "OPENSSL_ENGINES",
  "OPENSSL_MODULES",
  // Commands and programs git and ssh run on their own behalf.
  "GIT_SSH",
  "GIT_SSH_COMMAND",
  "GIT_ASKPASS",
  "GIT_PROXY_COMMAND",
  "GIT_EXTERNAL_DIFF",
  "GIT_PAGER",
  "GIT_EDITOR",
  "GIT_EXEC_PATH",
  "GIT_TEMPLATE_DIR",
  // A glibc path that can load extra locale or conversion modules.
  "GCONV_PATH",
  "SSH_ASKPASS",
  "SSH_ASKPASS_REQUIRE",
]);
// Whole families a single variable name cannot enumerate: dynamic-loader injection, Rakazo's own
// namespace, git's config file set, and npm's configuration overrides.
const RESERVED_COMMAND_VARIABLE_PREFIXES = [
  "LD_",
  "DYLD_",
  "RAKAZO_",
  "GIT_CONFIG_",
  "NPM_CONFIG_",
];

/** The environment variable a command credential is exported as: `netbird-setup-key` → `NETBIRD_SETUP_KEY`. */
export function commandVariableName(credentialName: string): string {
  return credentialName.toUpperCase().replace(/-/g, "_");
}

/** Why a variable name cannot be exported, or undefined when it can. */
export function commandVariableProblem(variable: string): "invalid" | "reserved" | undefined {
  if (!AGENT_SECRET_NAME_PATTERN.test(variable)) return "invalid";
  if (
    RESERVED_COMMAND_VARIABLE_NAMES.has(variable) ||
    RESERVED_COMMAND_VARIABLE_PREFIXES.some((prefix) => variable.startsWith(prefix))
  ) {
    return "reserved";
  }
  return undefined;
}

function commandVariableNameIssue(credentialName: string): string | undefined {
  const variable = commandVariableName(credentialName);
  const problem = commandVariableProblem(variable);
  if (problem === "reserved") {
    return `$${variable} is reserved and cannot be used as a command variable; choose another name`;
  }
  if (problem === "invalid") return `$${variable} is not a valid environment variable name`;
  return undefined;
}

/** Hosts inside a deployment's own network (loopback, RFC1918, CGNAT, .local). */
export function isPrivateNetworkHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (host.endsWith(".local")) return true;
  if (/^10(?:\.\d{1,3}){3}$/.test(host)) return true;
  if (/^192\.168(?:\.\d{1,3}){2}$/.test(host)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])(?:\.\d{1,3}){2}$/.test(host)) return true;
  if (/^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])(?:\.\d{1,3}){2}$/.test(host)) return true;
  return false;
}

/** Provider metadata endpoints that must never become credential targets,
 * even though they sit inside otherwise-private ranges (CGNAT / link-local). */
export function isCloudMetadataHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    host === "169.254.169.254" ||
    host === "169.254.170.2" ||
    host === "100.100.100.200" ||
    host === "metadata.google.internal" ||
    host === "metadata.goog"
  );
}

function botSecretOriginSchema(allowPrivateHttpOrigin: boolean) {
  return z
    .string()
    .max(2048)
    .refine(
      (value) => {
        try {
          const url = new URL(value);
          if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
            return false;
          }
          if (isCloudMetadataHost(url.hostname)) return false;
          if (url.protocol === "https:") return true;
          return (
            allowPrivateHttpOrigin && url.protocol === "http:" && isPrivateNetworkHost(url.hostname)
          );
        } catch {
          return false;
        }
      },
      allowPrivateHttpOrigin
        ? "Expected an HTTPS origin, or an HTTP origin on a private LAN host, without a path, credentials, query, or fragment"
        : "Expected an HTTPS origin without a path, credentials, query, or fragment",
    );
}

export function botSecretDestinationSchema(options?: { allowPrivateHttpOrigin?: boolean }) {
  const originSchema = botSecretOriginSchema(options?.allowPrivateHttpOrigin === true);
  return z
    .object({
      name: BotSecretName,
      // Empty for a command variable, which has no site. Every other type needs an origin.
      origin: z.string().max(2048).default(""),
      auth: BotSecretAuth,
    })
    .superRefine((destination, ctx) => {
      if (destination.auth.type === "command") {
        if (destination.origin !== "") {
          ctx.addIssue({
            code: "custom",
            path: ["origin"],
            message: "Command variables have no site; leave origin empty",
          });
        }
        const nameIssue = commandVariableNameIssue(destination.name);
        if (nameIssue) ctx.addIssue({ code: "custom", path: ["name"], message: nameIssue });
        return;
      }
      const origin = originSchema.safeParse(destination.origin);
      if (!origin.success) {
        for (const issue of origin.error.issues) {
          ctx.addIssue({ code: "custom", path: ["origin"], message: issue.message });
        }
        return;
      }
      // Private-LAN plain HTTP is for API credentials only. A website login is typed into a page.
      if (destination.auth.type !== "login") return;
      try {
        if (new URL(destination.origin).protocol === "https:") return;
      } catch {
        /* The origin schema already rejects unparseable values. */
      }
      ctx.addIssue({
        code: "custom",
        path: ["origin"],
        message: "Website logins require an HTTPS origin",
      });
    });
}
export const BotSecretDestination = botSecretDestinationSchema();
export type BotSecretDestination = z.infer<typeof BotSecretDestination>;

export const LoginSecretValue = z.object({
  username: z.string().min(1).max(512),
  password: z.string().min(1).max(4096),
});
export type LoginSecretValue = z.infer<typeof LoginSecretValue>;

export function encodeLoginSecret(value: LoginSecretValue): string {
  return JSON.stringify(LoginSecretValue.parse(value));
}

export function decodeLoginSecret(plaintext: string): LoginSecretValue {
  return LoginSecretValue.parse(JSON.parse(plaintext));
}

/** Written atomically with the protected value, distinct from action approval. */
export function botSecretSubmissionSchema(options?: { allowPrivateHttpOrigin?: boolean }) {
  return z.object({ credentialSaved: botSecretDestinationSchema(options) });
}
export const BotSecretSubmission = botSecretSubmissionSchema();

export const BOT_SECRET_VALUE_MAX_LENGTH = 16_384;

/**
 * Owner-facing destination input. Structural only: the origin rules depend on the server's
 * private-HTTP opt-in, so the server enforces them when it stores the value.
 */
export const BotSecretDestinationInput = z
  .object({
    name: BotSecretName,
    // Omitted or empty for a command variable, which has no site.
    origin: z.string().max(2048).default(""),
    auth: BotSecretAuth,
  })
  .superRefine((destination, ctx) => {
    if (destination.auth.type !== "command" && destination.origin.length === 0) {
      ctx.addIssue({ code: "custom", path: ["origin"], message: "A site is required" });
    }
  });

export const BotSecretPutInput = z.object({
  botId: Id,
  destination: BotSecretDestinationInput,
  value: z.string().min(1).max(BOT_SECRET_VALUE_MAX_LENGTH),
});
export type BotSecretPutInput = z.infer<typeof BotSecretPutInput>;

/**
 * What the owner can see about a saved credential. It never carries the protected value.
 * `name` is read loosely and `auth` is nullable so one stored row that no longer passes the
 * current schema cannot fail the whole list call and lock the owner out of removing it.
 * A null `auth` means the stored settings can't be read.
 */
export const BotSecretMetadata = z.object({
  name: StoredBotSecretName,
  origin: z.string(),
  auth: BotSecretAuth.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BotSecretMetadata = z.infer<typeof BotSecretMetadata>;

export const SecretHttpRequest = z
  .object({
    name: BotSecretName,
    url: z.string().max(8192),
    method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"]).default("GET"),
    body: z.string().max(100_000).optional(),
    contentType: z
      .enum(["application/json", "application/x-www-form-urlencoded", "text/plain"])
      .default("application/json"),
  })
  .refine(
    (request) => request.body === undefined || !["GET", "HEAD"].includes(request.method),
    "This method cannot have a body",
  );
