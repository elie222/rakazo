import { z } from "zod";
import { AGENT_SECRET_NAME_PATTERN } from "./agent-secret-name.js";
import { Id } from "./ids.js";
import { isCloudMetadataHost, isPrivateNetworkHost } from "./network-host.js";
import { settingsScopeInput } from "./settings-scope.js";

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
  // A website sign-in. Its fields are all protected; the backend only types them into pages on
  // the saved origin and never sends them as HTTP credentials.
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

export const BOT_SECRET_ORIGIN_MISSING_MESSAGE =
  "Missing. Add the site's address, such as https://www.example.com";

export function botSecretDestinationSchema(options?: { allowPrivateHttpOrigin?: boolean }) {
  const originSchema = botSecretOriginSchema(options?.allowPrivateHttpOrigin === true);
  return z
    .object({
      name: BotSecretName,
      // Empty for a command variable, which has no site. Every other type needs an origin.
      origin: z
        .string()
        .max(2048)
        .default("")
        .describe(
          "The site's address, such as https://www.example.com. Required unless auth is command.",
        ),
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
      if (destination.origin === "") {
        // Say it is missing: "Expected an HTTPS origin" reads as a bad value, and models resend it.
        ctx.addIssue({
          code: "custom",
          path: ["origin"],
          message: BOT_SECRET_ORIGIN_MISSING_MESSAGE,
        });
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

export const BOT_SECRET_VALUE_MAX_LENGTH = 16_384;

export const LOGIN_FIELD_LIMIT = 8;
export const LoginFieldLabel = z.string().trim().min(1).max(64);
/** What a login asks for when no field labels are given, and what a saved username/password pair reads as. */
export const DEFAULT_LOGIN_FIELD_LABELS = ["Username", "Password"] as const;

/**
 * One value of a website login. A hidden value is typed only into a password field; a visible
 * one into any text field on the login's site. Only the person chooses which.
 */
export const LoginFieldInput = z.object({
  label: LoginFieldLabel,
  value: z.string().max(4096),
  hidden: z.boolean(),
});
export type LoginFieldInput = z.infer<typeof LoginFieldInput>;
export const LoginField = LoginFieldInput.transform((field) =>
  field.hidden ? field : { ...field, value: field.value.trim() },
).refine((field) => field.value.length > 0, "Enter a value");
export type LoginField = z.infer<typeof LoginField>;

export function sameLoginFieldLabel(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

function uniqueLabels(labels: readonly string[]): boolean {
  return new Set(labels.map((label) => label.trim().toLowerCase())).size === labels.length;
}

export const LoginFieldLabels = z
  .array(LoginFieldLabel)
  .min(1)
  .max(LOGIN_FIELD_LIMIT)
  .refine(uniqueLabels, "Give each field a different label");

export const LoginSecretValue = z
  .object({ fields: z.array(LoginField).min(1).max(LOGIN_FIELD_LIMIT) })
  .refine(
    (login) => uniqueLabels(login.fields.map((field) => field.label)),
    "Give each field a different label",
  )
  .refine(
    (login) => JSON.stringify(login).length <= BOT_SECRET_VALUE_MAX_LENGTH,
    "This login is too long",
  );
export type LoginSecretValue = z.infer<typeof LoginSecretValue>;

// Logins saved before fields existed. Never written again, so a release that predates fields
// fails to parse a new value instead of misreading it.
const LegacyLoginSecretValue = z.object({
  username: z.string().min(1).max(512),
  password: z.string().min(1).max(4096),
});

export function encodeLoginSecret(value: z.input<typeof LoginSecretValue>): string {
  return JSON.stringify(LoginSecretValue.parse(value));
}

export function decodeLoginSecret(plaintext: string): LoginSecretValue {
  const parsed: unknown = JSON.parse(plaintext);
  const legacy = LegacyLoginSecretValue.safeParse(parsed);
  if (!legacy.success) return LoginSecretValue.parse(parsed);
  const [username, password] = DEFAULT_LOGIN_FIELD_LABELS;
  return {
    fields: [
      { label: username, value: legacy.data.username, hidden: false },
      { label: password, value: legacy.data.password, hidden: true },
    ],
  };
}

// A field starts visible only when every word of its label is one of these and at least one is
// an identifier. Any other word, a misspelling or a look-alike letter included, keeps it hidden.
// English and Hebrew.
const IDENTIFIER_WORDS = new Set([
  "id",
  "user",
  "username",
  "login",
  "email",
  "mail",
  "phone",
  "mobile",
  "cell",
  "tel",
  "telephone",
  "account",
  "member",
  "customer",
  "זהות",
  "תז",
  "טלפון",
  "נייד",
  "פלאפון",
  "סלולרי",
  "מייל",
  "אימייל",
  "דואל",
  "משתמש",
  "חשבון",
  "לקוח",
  "חבר",
]);
const FILLER_WORDS = new Set([
  "number",
  "no",
  "num",
  "name",
  "address",
  "or",
  "and",
  "of",
  "your",
  "the",
  "last",
  "first",
  "digit",
  "digits",
  "national",
  "tax",
  "employee",
  "e",
  "תעודת",
  "מספר",
  "שם",
  "כתובת",
  "או",
  "של",
  "ו",
  "אחרונות",
  "ספרות",
  "לאומי",
  "עובד",
  "מס",
]);

function labelWords(label: string): string[] {
  return (
    label
      .normalize("NFKC")
      .normalize("NFD")
      .replace(/[\p{M}\p{Cf}]/gu, "")
      .toLowerCase()
      // Spaces and punctuation separate words; any other symbol or emoji is a word of its own, so a
      // label with one is not made only of known words.
      .match(/[\p{L}\p{N}.'"׳״]+|[^\p{L}\p{N}\p{Z}\s\p{P}№]/gu)
      ?.map((word) => word.replace(/[.'"׳״]/g, ""))
      .filter(Boolean) ?? []
  );
}

function knownWord(word: string, known: ReadonlySet<string>): boolean {
  // Hebrew attaches "the" to a word: הטלפון.
  return known.has(word) || (word.startsWith("ה") && known.has(word.slice(1)));
}

/** Whether a label is made only of identifier and plain filler words, such as "Phone number". */
export function isIdentifierLabel(label: string): boolean {
  const words = labelWords(label);
  return (
    words.some((word) => knownWord(word, IDENTIFIER_WORDS)) &&
    words.every(
      (word) =>
        /^\p{N}+$/u.test(word) ||
        knownWord(word, IDENTIFIER_WORDS) ||
        knownWord(word, FILLER_WORDS),
    )
  );
}

/**
 * The empty fields a login card starts with. The default Username and Password card starts as
 * logins always have, Username visible. Fields the bot names start hidden, except those whose
 * label is made only of identifier words (ID number, phone, email), which a sign-in without a
 * password field needs typed into a text field. The system decides this from the label alone; the bot
 * can't preset a field, and the person can switch any of them before saving.
 */
export function loginCardFields(requested: readonly string[] | undefined): LoginFieldInput[] {
  if (!requested) {
    return DEFAULT_LOGIN_FIELD_LABELS.map((label, index) => ({
      label,
      value: "",
      hidden: index > 0,
    }));
  }
  return requested.map((label) => ({ label, value: "", hidden: !isIdentifierLabel(label) }));
}

/**
 * The login a card's answer saves, or undefined unless it answers exactly the requested fields,
 * in order. An app that predates fields answers a Username and Password card with `username`
 * and the password as `answer`.
 */
export function loginAnswerValue(
  requested: readonly string[] | undefined,
  input: { answer: string; username?: string; fields?: readonly LoginFieldInput[] },
): LoginSecretValue | undefined {
  const labels = requested ?? DEFAULT_LOGIN_FIELD_LABELS;
  const [usernameLabel, passwordLabel] = DEFAULT_LOGIN_FIELD_LABELS;
  const legacy =
    !input.fields && input.username !== undefined
      ? [
          { label: usernameLabel, value: input.username, hidden: false },
          { label: passwordLabel, value: input.answer, hidden: true },
        ]
      : undefined;
  const fields = input.fields ?? legacy;
  if (
    !fields ||
    (input.fields && (input.answer !== "" || input.username !== undefined)) ||
    fields.length !== labels.length ||
    fields.some((field, index) => field.label.trim() !== labels[index])
  ) {
    return undefined;
  }
  return LoginSecretValue.safeParse({ fields }).data;
}

export const GENERATED_SECRET_SYMBOLS = "!@#$%^&*-_=+?";

/** Character rules for a password or other value the backend generates and saves for a bot. */
export const GeneratedSecretRules = z
  .object({
    length: z.number().int().min(8).max(128).default(20),
    lowercase: z.boolean().default(true),
    uppercase: z.boolean().default(true),
    digits: z.boolean().default(true),
    symbols: z.boolean().default(true),
    // Printable ASCII punctuation only, for sites and tools that accept just a few symbols.
    allowedSymbols: z
      .string()
      .regex(/^[!-/:-@[-`{-~]{1,32}$/, "Use only punctuation characters")
      .optional(),
  })
  .refine(
    (rules) => rules.lowercase || rules.uppercase || rules.digits || rules.symbols,
    "Allow at least one kind of character",
  );
export type GeneratedSecretRules = z.infer<typeof GeneratedSecretRules>;

/** A login is saved for one site with its username; a command variable reaches shell commands. */
export const GenerateSecretInput = z
  .object({
    name: BotSecretName,
    type: z.enum(["login", "command"]),
    origin: z.string().min(1).max(2048).optional(),
    username: LegacyLoginSecretValue.shape.username.optional(),
    // A login's password also saved as the command variable `<name>-password`, for a CLI.
    command: z.boolean().optional(),
    rules: GeneratedSecretRules.optional(),
  })
  .superRefine((input, ctx) => {
    if (input.type === "command") {
      if (input.command !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["command"],
          message: "Only a login can also be saved as a command variable",
        });
      }
      if (input.origin !== undefined || input.username !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["type"],
          message: "A command variable has no site or username",
        });
      }
      return;
    }
    if (input.origin === undefined) {
      ctx.addIssue({ code: "custom", path: ["origin"], message: "A login needs its site" });
    }
    if (input.username === undefined) {
      ctx.addIssue({ code: "custom", path: ["username"], message: "A login needs a username" });
    }
    if (input.command && !BotSecretName.safeParse(loginCommandName(input.name)).success) {
      ctx.addIssue({
        code: "custom",
        path: ["name"],
        message: "Use a name of at most 55 characters to also save a command variable",
      });
    }
  });

/** The command variable a generated login's password is also saved as. */
export function loginCommandName(loginName: string): string {
  return `${loginName}-password`;
}
export type GenerateSecretInput = z.infer<typeof GenerateSecretInput>;

/** Written atomically with the protected value, distinct from action approval. */
export function botSecretSubmissionSchema(options?: { allowPrivateHttpOrigin?: boolean }) {
  return z.object({ credentialSaved: botSecretDestinationSchema(options) });
}
export const BotSecretSubmission = botSecretSubmissionSchema();

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

/** A credential the owner saves in a vault: the account's or, with scope "space", the Space's. */
export const VaultPutInput = settingsScopeInput.extend({
  destination: BotSecretDestinationInput,
  value: BotSecretPutInput.shape.value,
});
export type VaultPutInput = z.infer<typeof VaultPutInput>;

export const VaultRevealInput = settingsScopeInput.extend({ name: StoredBotSecretName });

/** A saved value shown to its owner after they confirm it's them: a login's fields, or the value. */
export const VaultRevealed = z.union([
  z.object({
    fields: z.array(z.object({ label: z.string(), value: z.string(), hidden: z.boolean() })),
  }),
  z.object({ value: z.string() }),
]);
export type VaultRevealed = z.infer<typeof VaultRevealed>;

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
