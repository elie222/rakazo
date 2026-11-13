import { z } from "zod";
import { AGENT_SECRET_NAME_PATTERN } from "./agent-secret-name.js";
import { INBOUND_EMAIL_HEADER_MAX_CHARS, INBOUND_EMAIL_TEXT_MAX_CHARS } from "./bot-email.js";
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
  // A payment card. Typed only into a checkout the person approves each time; the bot sees only
  // its brand, last four digits and expiry.
  z.object({ type: z.literal("card") }),
  // A person's name, address, phone or email. Not secret: the bot reads it to fill in forms.
  z.object({ type: z.literal("contact") }),
]);
export type BotSecretAuthType = z.infer<typeof BotSecretAuth>["type"];

/** Kinds saved without a site: command variables reach shell commands, cards and contacts any page. */
export function isSitelessAuth(type: BotSecretAuthType): type is "command" | "card" | "contact" {
  return type === "command" || type === "card" || type === "contact";
}

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
      // Empty for a command variable, card or contact, which have no site. Every other type needs one.
      origin: z
        .string()
        .max(2048)
        .default("")
        .describe(
          "The site's address, such as https://www.example.com. Required unless auth is command, card or contact.",
        ),
      auth: BotSecretAuth,
    })
    .superRefine((destination, ctx) => {
      if (isSitelessAuth(destination.auth.type)) {
        if (destination.origin !== "") {
          ctx.addIssue({
            code: "custom",
            path: ["origin"],
            message: `A ${destination.auth.type === "command" ? "command variable" : destination.auth.type} has no site; leave origin empty`,
          });
        }
        if (destination.auth.type !== "command") return;
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

/** The one page a texted or emailed code may be typed into: HTTPS only, and it is never saved. */
export const OneTimeCodeTarget = z.object({ origin: botSecretOriginSchema(false) });
export type OneTimeCodeTarget = z.infer<typeof OneTimeCodeTarget>;

export const ONE_TIME_CODE_MIN_LENGTH = 4;
export const ONE_TIME_CODE_MAX_LENGTH = 12;

/**
 * The code as typed into a page: spaces dropped ("123 456"), then groups of letters and digits
 * joined by single dashes, at least 4 of them and at most 12 characters in all. Anything shorter
 * or odder is not a code, so it is never kept or redacted.
 */
export function normalizeOneTimeCode(answer: string): string | undefined {
  const code = answer.replace(/\s+/g, "");
  return code.length <= ONE_TIME_CODE_MAX_LENGTH &&
    code.replaceAll("-", "").length >= ONE_TIME_CODE_MIN_LENGTH &&
    /^[A-Za-z0-9]+(-[A-Za-z0-9]+)*$/.test(code)
    ? code
    : undefined;
}

/**
 * Whether a code can be hidden wherever it appears on its own: 6 digits or more, or letters with
 * digits. Hiding a bare 4- or 5-digit number would blank years, prices and counts too, so only
 * these are taken from an email, and only these are hidden bare.
 */
export function oneTimeCodeStandsAlone(code: string): boolean {
  const characters = code.replaceAll("-", "");
  return characters.length >= 6 || /[A-Za-z]/.test(characters);
}

/** Digit groups a code may be split into as an email writes it: "482 913", "4829-1375". */
const CODE_GROUP_SIZES = [4, 3];
const CODE_GROUP_SEPARATORS = [" ", "-"];

/**
 * Every way an email may write `code` that readOneTimeCode reads as this code: as is, and a
 * code of two equal digit groups split by a space or a dash. A run that holds a code taken from
 * an email hides each of these in everything it reads (oneTimeCodeRedactions), and its emails
 * also hide any spelling of the code (hideOneTimeCodeInEmail).
 */
export function oneTimeCodeWritings(code: string): string[] {
  const writings = [code];
  if (!/^[0-9]+$/.test(code)) return writings;
  for (const size of CODE_GROUP_SIZES) {
    if (code.length !== size * 2) continue;
    for (const separator of CODE_GROUP_SEPARATORS) {
      writings.push(`${code.slice(0, size)}${separator}${code.slice(size)}`);
    }
  }
  return writings;
}

/**
 * What stands where a hidden value was, in whatever hides one from a run: redactSecrets and the
 * redactors beside it, and hideOneTimeCodeInEmail. A search over hidden text leaves it out, so
 * every writer and every reader of the mark takes it from here.
 */
export const REDACTED_MARK = "[redacted]";

// Whitespace, invisible format characters, dots, dashes and middle dot.
const SPELLING_SEPARATORS = String.raw`[\s\p{Cf}.\p{Pd}\u00b7]*`;

/**
 * Email text with `code` hidden as its characters in order, in either case, with any run of
 * separators between them ("482 913", "4.8.2.9.1.3", one digit per line). No separator can be a
 * code character, so a separator is read only by match attempts that start within the code's
 * length before it: the time is linear in the text. `code` is one normalizeOneTimeCode accepted.
 */
export function hideOneTimeCodeInEmail(text: string, code: string): string {
  const characters = [...code.replaceAll("-", "")];
  if (!characters.length) return text;
  return text.replace(new RegExp(characters.join(SPELLING_SEPARATORS), "giu"), REDACTED_MARK);
}

// Han, kana and Hangul text puts no space around a number, so those letters may touch a code.
const SPACELESS = String.raw`\p{sc=Han}\p{sc=Hiragana}\p{sc=Katakana}\p{sc=Hangul}`;
// A code stands as its own word: not part of a link, an amount, a phone number or a date, so not
// next to a letter, digit, currency sign or link punctuation, nor a digit group a space away.
const CODE_LEAD = String.raw`(?<!(?![${SPACELESS}])[\p{L}\p{N}_+#$€£¥@/\\.,=&?%-])(?<![0-9][ .-])`;
// Punctuation joining it to a letter or digit after it, or a digit group a space after it.
const JOINED_AFTER = String.raw`[.,:/-][\p{L}\p{N}]| [0-9]`;
const CODE_TRAIL = String.raw`(?!(?![${SPACELESS}])[\p{L}\p{N}_@/\\%€$£¥]|${JOINED_AFTER})`;
const CODE_SEPARATORS = `[${CODE_GROUP_SEPARATORS.join("")}]`;
const CODE_FORMS = [
  // Two equal digit groups, as oneTimeCodeWritings writes them.
  ...CODE_GROUP_SIZES.map((size) => `[0-9]{${size}}${CODE_SEPARATORS}[0-9]{${size}}`),
  "[0-9]{4,8}",
  // Capital letters and digits, both; capitals only, as the code's token has no `i` flag.
  "(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*[0-9])[A-Z0-9]{6,8}",
];
const YEAR_PATTERN = "^(?:19|20)[0-9]{2}$";
const YEAR = new RegExp(YEAR_PATTERN);

// Han, kana and Hangul text puts no space between words, so their letters end a word written in
// another script: "您的code是" names a code. A word in those scripts has no word edges at all.
const NOT_WORD_EDGE = String.raw`(?![${SPACELESS}])[\p{L}\p{M}\p{N}]`;
/** Where a word may start: not right after a letter, mark or digit of a script with word edges. */
const WORD_START = `(?<!${NOT_WORD_EDGE})`;
const word = (cue: string) => String.raw`${WORD_START}(?:${cue})(?!(?![${SPACELESS}])[\p{L}\p{M}])`;
/** A word by its distinctive start, with whatever ending it has. */
const stem = (cue: string) => String.raw`${WORD_START}(?:${cue})[\p{L}\p{M}]*`;

/**
 * The words an email may use around a sign-in code, in each language the app ships. A unit of
 * text (a sentence or a line) yields a code only when it is made of nothing but these words and
 * the code, in one of the forms readUnit lists. `cue` names a sign-in code (code, passcode, OTP,
 * PIN); `qualifier` is a word a cue may carry (verification, security, one-time); `filler` is
 * the little words such a sentence has around them (your, is, enter); `stale` is a word that says
 * a code is no longer good (old, previous, expired, invalid: past forms only, never "expires"),
 * so a sentence that names a code with one makes the whole email give none, whatever else it
 * says (namesStaleCode). Any other word, a number among them, or a noun that makes the cue name
 * something else (tracking code, code de suivi, ZIP code, promo code) keeps the unit from
 * yielding anything: the owner's card is the fallback. Each entry is a regex alternative for a
 * whole word; a `stem` takes any ending.
 */
const LANGUAGES: {
  language: string;
  cue: string[];
  qualifier: string[];
  filler: string[];
  stale: string[];
}[] = [
  {
    // English, and the words every language's emails borrow.
    language: "en",
    cue: [
      "codes?",
      "passcodes?",
      "otp",
      "2fa",
      "one[- ]time (?:password|passcode|pin)",
      // A bare PIN is a postal code in some countries, so only a sign-in PIN is a cue.
      "(?:verification|security|login|sign[- ]in|access|temporary) pin",
      "security key",
    ].map(word),
    qualifier: [
      "verification",
      "verify",
      "security",
      "sign[- ]?in",
      "log[- ]?in",
      "one[- ]time",
      "confirmation",
      "authentication",
      "two[- ]factor",
      "access",
      "temporary",
      "[4-8][- ]digit",
      "account",
      "email",
      "device",
    ].map(word),
    filler: [
      "your",
      "the",
      "this",
      "is",
      "a",
      "an",
      "here",
      "here s",
      "below",
      "use",
      "enter",
      "please",
      "to",
      "sign",
      "log",
      "in",
      "for",
      "continue",
      "following",
      "new",
      "requested",
      "you",
      "has",
    ].map(word),
    stale: ["old", "previous", "expired", "invalid"].map(word),
  },
  {
    // German.
    language: "de",
    cue: [
      "(?:best[äa]tigungs|sicherheits|anmelde|zugangs|verifizierungs)?codes?",
      "(?:login|einmal|authentifizierungs)?codes?",
      "einmalpasswort",
      "einmalkennwort",
    ].map(word),
    qualifier: ["verifizierung", "bestätigung", "einmalig(?:e|er|es)?", "sicherheit"].map(word),
    filler: [
      "ihr",
      "ihre",
      "dein",
      "deine",
      "der",
      "die",
      "das",
      "ist",
      "lautet",
      "hier",
      "bitte",
      "geben",
      "sie",
      "ein",
      "zum",
      "zur",
      "anmelden",
      "einloggen",
      "unten",
      "folgenden",
      "nutzen",
      "verwenden",
    ].map(word),
    stale: [
      "alt(?:e|er|en|es|em)?",
      "vorherig(?:e|er|en|es|em)?",
      "vorig(?:e|er|en|es|em)?",
      "abgelaufen(?:e|er|en|es|em)?",
      "ungültig(?:e|er|en|es|em)?",
    ].map(word),
  },
  {
    // Spanish.
    language: "es",
    cue: ["c[óo]digos?", "contraseña de un solo uso"].map(word),
    qualifier: [
      "verificaci[óo]n",
      "seguridad",
      "acceso",
      "inicio de sesi[óo]n",
      "confirmaci[óo]n",
      "un solo uso",
      "autenticaci[óo]n",
      "temporal",
    ].map(word),
    filler: [
      "tu",
      "su",
      "el",
      "la",
      "es",
      "de",
      "este",
      "esta",
      "aqu[íi]",
      "usa",
      "use",
      "utiliza",
      "introduce",
      "ingresa",
      "para",
      "iniciar",
      "sesi[óo]n",
      "continuaci[óo]n",
    ].map(word),
    stale: [
      "anterior(?:es)?",
      "antigu[oa]s?",
      "caducad[oa]s?",
      "caducó",
      "expirad[oa]s?",
      "expiró",
      "vencid[oa]s?",
      "venció",
      "inv[áa]lid[oa]s?",
    ].map(word),
  },
  {
    // French.
    language: "fr",
    cue: ["codes?", "mot de passe à usage unique"].map(word),
    qualifier: [
      "v[ée]rification",
      "s[ée]curit[ée]",
      "connexion",
      "confirmation",
      "usage unique",
      "authentification",
      "temporaire",
      "validation",
      "acc[èe]s",
    ].map(word),
    filler: [
      "votre",
      "vous",
      "le",
      "la",
      "ce",
      "est",
      "de",
      "d",
      "voici",
      "ci-dessous",
      "utilisez",
      "saisissez",
      "entrez",
      "pour",
      "connecter",
      "à",
    ].map(word),
    stale: [
      "ancien(?:ne)?s?",
      "précédent(?:e)?s?",
      "expiré(?:e)?s?",
      "périmé(?:e)?s?",
      "invalide(?:s)?",
    ].map(word),
  },
  {
    // Dutch.
    language: "nl",
    cue: [
      "(?:verificatie|beveiligings|inlog|toegangs|bevestigings|eenmalige)?codes?",
      "pincodes?",
      "eenmalig wachtwoord",
    ].map(word),
    qualifier: ["verificatie", "beveiliging", "eenmalig(?:e)?", "bevestiging"].map(word),
    filler: [
      "je",
      "jouw",
      "uw",
      "de",
      "het",
      "is",
      "dit",
      "hier",
      "hieronder",
      "gebruik",
      "voer",
      "in",
      "om",
      "te",
      "loggen",
      "luidt",
    ].map(word),
    stale: ["oud(?:e)?", "vorige", "verlopen", "ongeldig(?:e)?"].map(word),
  },
  {
    // Polish.
    language: "pl",
    cue: ["kod(?:y|u|em|ów)?", "hasło jednorazowe"].map(word),
    qualifier: [
      stem("weryfikac"),
      stem("jednorazow"),
      stem("potwierdz"),
      word("bezpieczeństwa"),
      word("logowania"),
      word("dostępu"),
    ],
    filler: [
      "twój",
      "twoja",
      "to",
      "jest",
      "oto",
      "poniżej",
      "wpisz",
      "użyj",
      "aby",
      "się",
      "zalogować",
      "zaloguj",
      "ten",
      "w",
    ].map(word),
    stale: [
      word("star(?:y|a|e|ego|ej)"),
      stem("poprzedni"),
      stem("wygasł"),
      stem("nieważn"),
      stem("nieaktualn"),
    ],
  },
  {
    // Portuguese.
    language: "pt",
    cue: ["c[óo]digos?", "senha de uso [úu]nico"].map(word),
    qualifier: [
      "verifica[çc][ãa]o",
      "seguran[çc]a",
      "acesso",
      "confirma[çc][ãa]o",
      "uso [úu]nico",
      "autentica[çc][ãa]o",
      "tempor[áa]rio",
    ].map(word),
    filler: [
      "seu",
      "sua",
      "o",
      "a",
      "é",
      "de",
      "este",
      "esta",
      "aqui",
      "está",
      "abaixo",
      "use",
      "insira",
      "digite",
      "para",
      "entrar",
      "fazer",
      "seguir",
    ].map(word),
    stale: [
      "antig[oa]s?",
      "anterior(?:es)?",
      "expirad[oa]s?",
      "expirou",
      "vencid[oa]s?",
      "venceu",
      "inv[áa]lid[oa]s?",
    ].map(word),
  },
  {
    // Russian.
    language: "ru",
    cue: ["код(?:а|у|ом|е|ы|ов)?", "пин-код", "одноразовый пароль"].map(word),
    qualifier: [
      stem("подтвержд"),
      stem("верификац"),
      stem("одноразов"),
      stem("безопасност"),
      stem("авторизац"),
      word("входа"),
      word("доступа"),
    ],
    filler: [
      "ваш",
      "ваша",
      "ваше",
      "твой",
      "это",
      "для",
      "в",
      "вход",
      "введите",
      "используйте",
      "ниже",
      "чтобы",
      "войти",
      "войдите",
      "с",
    ].map(word),
    stale: [
      word("стар(?:ый|ая|ое|ого|ом|ые|ых)"),
      stem("предыдущ"),
      stem("прежн"),
      stem("устаревш"),
      stem("недействительн"),
      stem("просрочен"),
      word("ист[её]к(?:ла|ло|ли)?"),
    ],
  },
  {
    // Turkish.
    language: "tr",
    cue: ["kod(?:u|unuz|lar)?", "tek kullanımlık şifre"].map(word),
    qualifier: [
      "doğrulama",
      "dogrulama",
      "güvenlik",
      "giriş",
      "tek kullanımlık",
      "onay",
      "erişim",
    ].map(word),
    filler: [
      "sizin",
      "bu",
      "için",
      "yapmak",
      "aşağıdaki",
      "girin",
      "kullanın",
      "lütfen",
      "ile",
    ].map(word),
    stale: ["eski", "önceki", "geçersiz", "süresi doldu", "süresi dolmuş"].map(word),
  },
  {
    // Hindi.
    language: "hi",
    cue: ["कोड", "ओटीपी"].map(word),
    qualifier: ["सत्यापन", "एक बार", "सुरक्षा", "लॉगिन", "पुष्टि"].map(word),
    filler: [
      // Your, your, is, this, of, for, please, enter, do, of, in, below.
      "आपका",
      "आपकी",
      "है",
      "यह",
      "के",
      "लिए",
      "कृपया",
      "दर्ज",
      "करें",
      "का",
      "में",
      "नीचे",
    ].map(word),
    stale: [
      "पुराना",
      "पुरानी",
      "पिछला",
      "पिछली",
      "अमान्य",
      "समाप्त हो गया",
      "समाप्त हो गई",
      "समाप्त हो चुका",
    ].map(word),
  },
  {
    // Hebrew joins "the", "of" and other one-letter words to the word itself.
    language: "he",
    cue: ["(?:[הבולמכש]|של)?(?:קוד(?:ים)?|סיסמה חד[- ]?פעמית)"].map(word),
    qualifier: ["(?:[הבולמכש]|של)?(?:אימות|אבטחה|כניסה|התחברות|אישור|חד[- ]?פעמית?)"].map(word),
    filler: [
      "שלך",
      "שלכם",
      "הוא",
      "הינו",
      "זה",
      "הזן",
      "הזינו",
      "הקלד",
      "את",
      "כדי",
      "להתחבר",
      "להיכנס",
      "כאן",
      "להלן",
      "הבא",
      "יש",
      "להזין",
    ].map(word),
    stale: [
      "(?:[הבולמכש]|של)?(?:ישנה?|קודמ(?:ת|ים)|קודם)",
      "פג תוקף(?:ו|ה)?",
      "אינו תקף",
      "לא תקף",
    ].map(word),
  },
  {
    // Japanese: words run together, so these are matched as written, longest first.
    language: "ja",
    cue: ["コード", "認証番号", "暗証番号", "ワンタイムパスワード"],
    qualifier: ["本人確認", "認証", "確認", "セキュリティ", "ログイン", "ワンタイム", "検証"],
    filler: [
      "あなたの",
      "お客様の",
      "こちらです",
      "こちら",
      "になります",
      "してください",
      "以下",
      "入力",
      "です",
      "は",
      "が",
      "の",
      "を",
      "に",
      "ご",
    ],
    stale: [
      "有効期限切れ",
      "有効期限が切れ",
      "期限切れ",
      "以前の",
      "前回の",
      "古い",
      "無効になりました",
      "無効です",
      "無効な",
    ],
  },
  {
    // Korean.
    language: "ko",
    cue: ["코드", "인증번호", "인증 번호", "일회용 비밀번호"],
    qualifier: ["인증", "확인", "보안", "로그인", "일회용"],
    filler: [
      "귀하의",
      "고객님의",
      "회원님의",
      "입니다",
      "해주세요",
      "하세요",
      "입력",
      "아래",
      "다음",
      "은",
      "는",
      "이",
      "가",
      "를",
      "을",
      "의",
    ],
    stale: ["만료되었", "만료된", "만료됐", "이전", "예전", "유효하지 않은"],
  },
  {
    // Chinese, simplified and traditional.
    language: "zh",
    cue: ["验证码", "校验码", "动态码", "动态密码", "驗證碼", "校驗碼", "動態密碼"],
    qualifier: ["验证", "登录", "一次性", "安全", "短信", "驗證", "登入"],
    filler: [
      "您的",
      "你的",
      "本次",
      "如下",
      "下方",
      "以下",
      "输入",
      "輸入",
      "使用",
      "是",
      "为",
      "為",
      "请",
      "請",
      "的",
      "此",
    ],
    stale: [
      "已过期",
      "已過期",
      "过期的",
      "過期的",
      "已失效",
      "无效的",
      "無效的",
      "之前的",
      "以前的",
      "旧的",
      "舊的",
      "上一个",
      "上一個",
    ],
  },
];

/** What may stand between a cue and its code: a colon, equals sign or dash. */
const SEPARATOR = String.raw`[:：=\p{Pd}]`;

// The longest alternative first, so a word is read whole ("codes" before "code", "あなたの"
// before "の"). The scanner takes the first alternative that matches at its position and never
// backs up, so the order decides, not any backtracking.
const longestFirst = (alternatives: string[]) =>
  [...new Set(alternatives)].sort((left, right) => right.length - left.length);
/**
 * Text as words are matched in it: composed (NFC), with the Turkish dotted capital I (U+0130),
 * the dotless small i (U+0131) and a small i with a dot above (U+0069 U+0307) all read as "i".
 * A case-insensitive match folds none of those to "i", so a notice in Turkish capitals would
 * not read as the same words in small letters; this folding is the same under every locale. It
 * changes no capital letter or digit a code is made of.
 */
const foldCase = (text: string) => text.normalize("NFC").replace(/\u0130|i\u0307|\u0131/gu, "i");
/**
 * Words in any case: "Code", "CODE" and "code" are one cue. Only words: never a code. Matched
 * with the `i` flag against text folded by foldCase, as the words themselves are here.
 */
const anyCaseWords = (alternatives: string[]) => `(?:${alternatives.map(foldCase).join("|")})`;
const CUE_WORDS = longestFirst(LANGUAGES.flatMap((language) => language.cue));
const STALE_WORDS = longestFirst(LANGUAGES.flatMap((language) => language.stale));
/**
 * The same words, for finding one anywhere in a sentence of any length: the word-start check
 * most of them begin with is made once at a position, not once for each word tried there.
 */
function anywhere(alternatives: string[]): string {
  const starts = (one: string) => one.startsWith(WORD_START);
  const edged = alternatives.filter(starts).map((one) => one.slice(WORD_START.length));
  const sources = [
    `${WORD_START}(?:${edged.join("|")})`,
    ...alternatives.filter((one) => !starts(one)),
  ];
  return foldCase(sources.join("|"));
}
/** A code word, and a word saying a code is no longer good, anywhere in a sentence. */
const CUE_ANYWHERE_PATTERN = anywhere(CUE_WORDS);
const STALE_ANYWHERE_PATTERN = anywhere(STALE_WORDS);
const CUE_ANYWHERE = new RegExp(CUE_ANYWHERE_PATTERN, "iu");
const STALE_ANYWHERE = new RegExp(STALE_ANYWHERE_PATTERN, "iu");
/**
 * A code as written, matched case-sensitively: no `i` flag, unlike the words, so its letters are
 * capitals only. Lowercase letters and digits ("Code abc123.") are a word the scanner cannot
 * read, so their unit gives nothing.
 */
const CODE_PATTERN = `${CODE_LEAD}(?:${CODE_FORMS.join("|")})${CODE_TRAIL}`;
/**
 * The kinds of token a unit may be made of, each as one regex that matches at a position: N a
 * code, C a cue, Q a qualifier, F a filler, S a separator. A unit holding anything else is not
 * read. No pattern quantifies a group, so none backtracks into a nested or overlapping loop, and
 * the scanner runs each at most once per token: reading a unit costs at most a fixed number of
 * regex executions per character, and a unit is at most ONE_TIME_CODE_UNIT_LIMIT long.
 */
const TOKEN_PATTERNS: readonly (readonly [kind: string, pattern: string, flags: string])[] = [
  ["N", CODE_PATTERN, "yu"],
  ["C", anyCaseWords(CUE_WORDS), "yiu"],
  ["Q", anyCaseWords(longestFirst(LANGUAGES.flatMap((language) => language.qualifier))), "yiu"],
  ["X", anyCaseWords(STALE_WORDS), "yiu"],
  ["F", anyCaseWords(longestFirst(LANGUAGES.flatMap((language) => language.filler))), "yiu"],
  ["S", SEPARATOR, "yu"],
];
export const ONE_TIME_CODE_TOKENS: readonly (readonly [kind: string, pattern: RegExp])[] =
  TOKEN_PATTERNS.map(([kind, pattern, flags]) => [kind, new RegExp(pattern, flags)]);

/**
 * A unit of text longer than this yields no code. A real sentence naming a code is far shorter,
 * and the cap bounds what reading one unit for a code can cost. It never keeps a sentence from
 * being read for a stale word (namesStaleCode): that takes two passes over it, whatever its length.
 */
export const ONE_TIME_CODE_UNIT_LIMIT = 200;

/**
 * A character that ends a unit inside a line: sentence and clause punctuation (Chinese, Japanese
 * and Hindi marks too), a bracket, a quote or a pipe. One character, so splitting never backs up;
 * "1,234" or "4.8.2" splits into pieces, none of which is a code, as none was.
 */
const UNIT_BREAK_PATTERN = String.raw`[.!?;,()[\]{}"“”«»|。！？।；，、]`;
const UNIT_BREAK = new RegExp(UNIT_BREAK_PATTERN, "u");

type Unit = {
  text: string;
  /** The unit is all its line holds, so a line of nothing but a code reads as one. */
  wholeLine: boolean;
  /** The unit ends its line (or is the subject), so the next unit is the line below it. */
  endsLine: boolean;
};

/**
 * The pieces of `text` between unit breaks, each folded (foldCase) and trimmed with its spaces
 * collapsed, blank ones dropped. Apostrophes read as spaces ("here's", "d'accès") so the words
 * around them stand whole.
 */
const pieces = (text: string) =>
  text
    .split(UNIT_BREAK)
    .map((part) => foldCase(part).replace(/['’]/gu, " ").replace(/\s+/gu, " ").trim())
    .filter(Boolean);

/** The sentences and lines of `text` in order: each line's pieces. */
function units(text: string): Unit[] {
  const result: Unit[] = [];
  for (const line of text.split("\n")) {
    const parts = pieces(line);
    for (const [index, part] of parts.entries()) {
      result.push({
        text: part,
        wholeLine: parts.length === 1,
        endsLine: index === parts.length - 1,
      });
    }
  }
  return result;
}

/**
 * The token kinds of a unit as a string ("FCSN" for "Your code: 482913") and the code tokens as
 * written; or undefined when the unit holds anything that is not a known word, a code or a
 * separator, or is longer than ONE_TIME_CODE_UNIT_LIMIT. A stale word (X) is known, so its unit
 * reads, but no form takes it: such a unit yields no code.
 */
function scanUnit(unit: string): { kinds: string; codes: string[] } | undefined {
  if (unit.length > ONE_TIME_CODE_UNIT_LIMIT) return undefined;
  let kinds = "";
  const codes: string[] = [];
  let at = 0;
  while (at < unit.length) {
    if (unit[at] === " ") {
      at++;
      continue;
    }
    let token: [string, string] | undefined;
    for (const [kind, pattern] of ONE_TIME_CODE_TOKENS) {
      pattern.lastIndex = at;
      const match = pattern.exec(unit);
      if (match?.[0]) {
        token = [kind, match[0]];
        break;
      }
    }
    if (!token) return undefined;
    const [kind, written] = token;
    kinds += kind;
    if (kind === "N") codes.push(written);
    at += written.length;
  }
  return { kinds, codes };
}

/**
 * The sentences of `text` that a stale word is read in: its pieces as for units(), except that a
 * line break inside a paragraph is a space, as mail wraps a sentence over lines. A sentence ends
 * at a unit break (sentence or clause punctuation, a bracket, a quote, a pipe) or a blank line,
 * and is as long as it is: every unit a code is read from is inside one of them.
 */
function sentences(text: string): string[] {
  const result: string[] = [];
  let paragraph: string[] = [];
  for (const line of [...text.split("\n"), ""]) {
    if (line.trim()) paragraph.push(line);
    else if (paragraph.length) {
      result.push(...pieces(paragraph.join(" ")));
      paragraph = [];
    }
  }
  return result;
}

/**
 * Whether a sentence names a code and says it is no longer good (old, previous, expired, invalid
 * in any of LANGUAGES), whatever else it holds and however long it is: such an email gives no
 * code. The sentence is the unit because that is what says one thing of another: a stale word
 * is about the code its own sentence names, and one in another sentence or paragraph ("Your
 * previous orders") is about something else.
 */
function namesStaleCode(sentence: string): boolean {
  return STALE_ANYWHERE.test(sentence) && CUE_ANYWHERE.test(sentence);
}

/** A phrase naming a code: cues, qualifiers and fillers in any order, with a cue among them. */
const NAMES_CODE = "[FQC]*C[FQC]*";
/**
 * The forms a clause's token kinds may take to give a code (R4 of ONE_TIME_CODE_RUBRIC), each a pattern over the kinds,
 * with exactly one code in it. Any word may carry a qualifier or another cue ("one-time PIN
 * code"); between cue and code only fillers, qualifiers and one separator may stand; after a
 * code in the first form only fillers and qualifiers ("to sign in").
 */
const CODE_FORM_PATTERNS = {
  /** "<cue> [is | : | = | -] <code>" and "<code> [is] your <cue>". */
  inOneClause: [`^${NAMES_CODE}S?N[FQ]*$`, `^NS?${NAMES_CODE}$`],
  /** A clause that only names a code and ends its line, over a line of nothing but the code. */
  overTwoLines: { names: `^${NAMES_CODE}S?$`, code: "^N$" },
};
const IN_ONE_CLAUSE = CODE_FORM_PATTERNS.inOneClause.map((form) => new RegExp(form));
const NAMES_A_CODE = new RegExp(CODE_FORM_PATTERNS.overTwoLines.names);
const ONLY_A_CODE = new RegExp(CODE_FORM_PATTERNS.overTwoLines.code);

/**
 * The rubric an email is read for a sign-in code by. No model may see a code, so this judgement
 * is made by fixed rules and word lists and never by a model: a deliberate exception to judging
 * prose with a model. The rules are checked against the calibration emails in
 * bot-secrets.test.ts, which cover every language listed, and a change to any list, form or
 * limit here takes a new ONE_TIME_CODE_RUBRIC_VERSION: a test pins the two together.
 *
 * R1. Only the subject and the text are read, and no more of either than the inbox keeps
 *     (`limits`). An email with more than that gives no code: what was not read could name
 *     another code or say this one expired.
 * R2. Each is split into units, a line's pieces between unit breaks (`unitBreak`). A unit longer
 *     than `limits.unit` gives nothing.
 * R3. A unit is read only when it is nothing but known tokens (`tokens`): a code (N), a cue (C),
 *     a qualifier (Q), a stale word (X), a filler (F) and a separator (S), in the words of
 *     `languages`. Any other word keeps the unit from giving anything.
 * R4. A unit gives a code only in one of `forms`: "<cue> is <code>", "<code> is your <cue>", or
 *     a unit that names a code and ends its line over a line holding the code alone.
 * R5. A sentence that holds a cue and a stale word (`staleSentence`) makes the whole email give
 *     no code, whatever else it says.
 * R6. The email gives a code only when it holds exactly one, which stands alone and is not a
 *     year (`year`). Several codes, or one too short to take, give none.
 * R7. Whatever gives no code leaves the owner's card as the answer.
 */
export const ONE_TIME_CODE_RUBRIC_VERSION = 1;
export const ONE_TIME_CODE_RUBRIC = {
  version: ONE_TIME_CODE_RUBRIC_VERSION,
  limits: {
    subject: INBOUND_EMAIL_HEADER_MAX_CHARS,
    text: INBOUND_EMAIL_TEXT_MAX_CHARS,
    unit: ONE_TIME_CODE_UNIT_LIMIT,
  },
  unitBreak: UNIT_BREAK_PATTERN,
  languages: LANGUAGES,
  tokens: TOKEN_PATTERNS,
  forms: CODE_FORM_PATTERNS,
  staleSentence: { cue: CUE_ANYWHERE_PATTERN, stale: STALE_ANYWHERE_PATTERN },
  year: YEAR_PATTERN,
} as const;

/** Whether a unit's token kinds take one of the forms that give a code in one clause. */
const yieldsCode = (kinds: string) => IN_ONE_CLAUSE.some((form) => form.test(kinds));

/**
 * The code a unit writes in a form yieldsCode accepts, or, when the unit only names a code and
 * ends its line, the code the line below holds alone. Undefined when the unit takes no such form.
 */
function readUnit(unit: Unit, below: Unit | undefined): string | undefined {
  const scanned = scanUnit(unit.text);
  if (!scanned) return undefined;
  if (yieldsCode(scanned.kinds)) return scanned.codes[0];
  if (!NAMES_A_CODE.test(scanned.kinds)) return undefined;
  const next = unit.endsLine && below?.wholeLine ? scanUnit(below.text) : undefined;
  return next && ONLY_A_CODE.test(next.kinds) ? next.codes[0] : undefined;
}

/**
 * What an email says of a one-time code: the one it gives, as it would be typed (digit groups
 * joined), or none. The subject and each sentence or line of the text is read on its own
 * (readUnit), and yields a code only when it is written in one of a few fixed forms with the
 * words LANGUAGES lists and nothing else: "Your verification code is 482913", "Code: 482913",
 * "482913 is your sign-in code", or "Your code:" on a line with the code alone on the next; the
 * subject counts as the line above the text. Anything else, an order or tracking number near a
 * code word included, yields nothing. The email gives a code only when it holds exactly one, the
 * same one wherever it appears, and that one stands alone (oneTimeCodeStandsAlone), as a shorter
 * one could not be hidden. Without one it is `unclear` when it names a code all the same: it
 * writes several, or one too short to take, or has a sentence naming a code with a `stale` word
 * ("This code has expired", namesStaleCode), whether or not it also names a current one, or it
 * writes one and its subject or text is as long as the inbox keeps of it or longer. Only that much
 * of either is read (INBOUND_EMAIL_HEADER_MAX_CHARS, INBOUND_EMAIL_TEXT_MAX_CHARS), which bounds
 * what reading one email can cost, and such an email gives no code: what the inbox cut, or what
 * was not read, could say the code expired or name another. A subject the inbox cut is exactly
 * as long as it keeps, so one that long counts as cut; a text it cut is longer, by the mark it
 * leaves. An unclear email leaves in doubt every code its sender wrote around then; one that
 * names no code, however long it is, does not. The rules are ONE_TIME_CODE_RUBRIC's.
 */
export function readOneTimeCode(email: { subject: string; text: string }): {
  code?: string;
  unclear: boolean;
} {
  const parts = [
    email.subject.slice(0, INBOUND_EMAIL_HEADER_MAX_CHARS),
    email.text.slice(0, INBOUND_EMAIL_TEXT_MAX_CHARS),
  ];
  const cut =
    email.subject.length >= INBOUND_EMAIL_HEADER_MAX_CHARS ||
    email.text.length > INBOUND_EMAIL_TEXT_MAX_CHARS;
  if (parts.some((part) => sentences(part).some(namesStaleCode))) return { unclear: true };
  const codes = new Set<string>();
  const all = parts.flatMap(units);
  for (const [index, unit] of all.entries()) {
    const written = readUnit(unit, all[index + 1]);
    if (written === undefined) continue;
    const code = normalizeOneTimeCode(written.replace(/[ -]/g, ""));
    if (!code || YEAR.test(code) || !oneTimeCodeWritings(code).includes(written)) continue;
    codes.add(code);
  }
  const [code] = codes;
  if (codes.size === 1 && code && oneTimeCodeStandsAlone(code) && !cut)
    return { code, unclear: false };
  return { unclear: codes.size > 0 };
}

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

export type AuthenticatorKey = {
  secret: string;
  algorithm: "sha1" | "sha256" | "sha512";
  digits: number;
  period: number;
};

export const AUTHENTICATOR_KEY_UNREADABLE = "This authenticator key can't be read.";
const AUTHENTICATOR_KEY_MAX_LENGTH = 1024;

/**
 * An authenticator key as people paste it: a base32 secret, spaces, dashes and case ignored, or an
 * otpauth://totp link, whose algorithm, digits and period are kept. Undefined when it is neither,
 * or when its secret can't be whole bytes.
 */
export function authenticatorKey(text: string): AuthenticatorKey | undefined {
  // The longest a login keeps, so every check that accepts a key also saves it.
  if (text.trim().length > AUTHENTICATOR_KEY_MAX_LENGTH) return undefined;
  let secret = text;
  const options = { algorithm: "sha1", digits: 6, period: 30 } as AuthenticatorKey;
  if (/^otpauth:/i.test(text.trim())) {
    if (!URL.canParse(text.trim())) return undefined;
    const url = new URL(text.trim());
    if (url.host.toLowerCase() !== "totp") return undefined;
    // Parameter names are matched without case, so a link with SECRET= reads as one with secret=.
    const params = new URLSearchParams(
      [...url.searchParams].map(([k, v]) => [k.toLowerCase(), v] as [string, string]),
    );
    secret = params.get("secret") ?? "";
    const algorithm = (params.get("algorithm") ?? "SHA1").toLowerCase();
    if (algorithm !== "sha1" && algorithm !== "sha256" && algorithm !== "sha512") return undefined;
    options.algorithm = algorithm;
    options.digits = Number(params.get("digits") ?? 6);
    options.period = Number(params.get("period") ?? 30);
    // What authenticator apps show, so a code typed here is the one the site expects.
    if (![6, 8].includes(options.digits) || ![30, 60].includes(options.period)) return undefined;
  }
  secret = secret.replace(/[\s-]/g, "").toUpperCase();
  const padding = secret.length - secret.replace(/=+$/, "").length;
  secret = secret.slice(0, secret.length - padding);
  // A key is whole bytes: 1, 3 or 6 characters past a group of eight never are, and padding,
  // when there is any, fills the last group exactly. Otherwise a mistyped key gives wrong codes.
  const remainder = secret.length % 8;
  if ([1, 3, 6].includes(remainder) || (padding > 0 && padding !== (8 - remainder) % 8))
    return undefined;
  return /^[A-Z2-7]{16,256}$/.test(secret) ? { ...options, secret } : undefined;
}

export const LoginSecretValue = z
  .object({
    fields: z.array(LoginField).min(1).max(LOGIN_FIELD_LIMIT),
    /** The authenticator key, opt-in; never typed itself, only the code it makes. */
    otp: z
      .string()
      .trim()
      .max(AUTHENTICATOR_KEY_MAX_LENGTH)
      .refine(
        (otp) => otp === "" || authenticatorKey(otp) !== undefined,
        "Invalid authenticator key",
      )
      .optional(),
  })
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

const destinationInputShape = {
  name: BotSecretName,
  // Omitted or empty for a command variable, card or contact, which have no site.
  origin: z.string().max(2048).default(""),
  auth: BotSecretAuth,
};

function requireSite(
  destination: { origin: string; auth: { type: BotSecretAuthType } },
  ctx: z.RefinementCtx,
) {
  if (!isSitelessAuth(destination.auth.type) && destination.origin.length === 0) {
    ctx.addIssue({ code: "custom", path: ["origin"], message: "A site is required" });
  }
}

/**
 * Owner-facing destination input. Structural only: the origin rules depend on the server's
 * private-HTTP opt-in, so the server enforces them when it stores the value.
 */
export const BotSecretDestinationInput = z.object(destinationInputShape).superRefine(requireSite);

export const BotSecretPutInput = z.object({
  botId: Id,
  destination: BotSecretDestinationInput,
  value: z.string().min(1).max(BOT_SECRET_VALUE_MAX_LENGTH),
});
export type BotSecretPutInput = z.infer<typeof BotSecretPutInput>;

// ---- Cards and contacts ----

/** Trimmed text, or undefined when empty, so an untouched form field is not saved as "". */
function optionalText(max: number) {
  return z
    .string()
    .trim()
    .max(max)
    .transform((value) => value || undefined)
    .optional();
}

/** The fields of a contact. Every one is optional, but a contact holds at least one. */
export const ContactFields = z.object({
  name: optionalText(200),
  line1: optionalText(200),
  line2: optionalText(200),
  city: optionalText(100),
  region: optionalText(100),
  postalCode: optionalText(20),
  country: optionalText(100),
  phone: optionalText(40),
  email: optionalText(254),
});
export type ContactFields = z.output<typeof ContactFields>;
export const CONTACT_FIELDS = Object.keys(ContactFields.shape) as (keyof ContactFields)[];

export const ContactSecretValue = ContactFields.strict().refine(
  (contact) => Object.values(contact).some(Boolean),
  "Fill in at least one field",
);
export type ContactSecretValue = z.output<typeof ContactSecretValue>;

/** Whether a card number passes the Luhn check every issuer's numbers do. */
export function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let index = 0; index < digits.length; index++) {
    let digit = Number(digits[digits.length - 1 - index]);
    if (index % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

/** Card numbers as people type them, with spaces or dashes, kept as digits only. */
export const CardNumber = z
  .string()
  .transform((value) => value.replace(/[\s-]/g, ""))
  .refine((digits) => /^\d{12,19}$/.test(digits) && luhnValid(digits), "Check the card number");

export const CardSecretValue = z
  .object({
    number: CardNumber,
    expMonth: z.number().int().min(1).max(12),
    expYear: z.number().int().min(2000).max(2100),
    cvc: z
      .string()
      .trim()
      .regex(/^(\d{3,4})?$/, "Check the security code")
      .optional()
      .transform((value) => value || undefined),
    name: optionalText(200),
    /** The name of a saved contact whose address bills this card. */
    billing: BotSecretName.optional(),
  })
  .strict();
export type CardSecretValue = z.output<typeof CardSecretValue>;

const CARD_BRANDS: [RegExp, string][] = [
  [/^4/, "Visa"],
  [/^(5[1-5]|222[1-9]|22[3-9]|2[3-6]|27[01]|2720)/, "Mastercard"],
  [/^3[47]/, "Amex"],
  [/^(6011|65|64[4-9]|622)/, "Discover"],
  [/^3(0[0-5]|[68])/, "Diners Club"],
  [/^35(2[89]|[3-8])/, "JCB"],
  [/^62/, "UnionPay"],
];

/** The card network a number belongs to, by its first digits; "Card" when it is not known. */
export function cardBrand(number: string): string {
  const digits = number.replace(/\D/g, "");
  return CARD_BRANDS.find(([prefix]) => prefix.test(digits))?.[1] ?? "Card";
}

export function cardSummary(card: CardSecretValue): CardSummary {
  return {
    brand: cardBrand(card.number),
    last4: card.number.slice(-4),
    expMonth: card.expMonth,
    expYear: card.expYear,
    ...(card.name ? { name: card.name } : {}),
    ...(card.billing ? { billing: card.billing } : {}),
  };
}

/** MM/YY, as checkouts and card faces show an expiry. */
export function cardExpiry(card: Pick<CardSummary, "expMonth" | "expYear">): string {
  return `${String(card.expMonth).padStart(2, "0")}/${String(card.expYear % 100).padStart(2, "0")}`;
}

/** "Visa ·· 4242", what a card is called when its owner gave it no title. */
export function cardTitle(card: Pick<CardSummary, "brand" | "last4">): string {
  return `${card.brand} ·· ${card.last4}`;
}

export function encodeCardSecret(value: z.input<typeof CardSecretValue>): string {
  return JSON.stringify(CardSecretValue.parse(value));
}

export function decodeCardSecret(plaintext: string): CardSecretValue {
  return CardSecretValue.parse(JSON.parse(plaintext));
}

export function encodeContactSecret(value: z.input<typeof ContactSecretValue>): string {
  return JSON.stringify(ContactSecretValue.parse(value));
}

export function decodeContactSecret(plaintext: string): ContactSecretValue {
  return ContactSecretValue.parse(JSON.parse(plaintext));
}

/**
 * Parse an expiry as people type it ("08/28", "8/2028", "0828") into a month and four-digit year,
 * or undefined when it is not one.
 */
export function parseCardExpiry(text: string): { expMonth: number; expYear: number } | undefined {
  const match = /^\s*(\d{1,2})\s*[/\-. ]?\s*(\d{2}|\d{4})\s*$/.exec(text);
  if (!match) return undefined;
  const expMonth = Number(match[1]);
  const year = Number(match[2]);
  if (expMonth < 1 || expMonth > 12) return undefined;
  return { expMonth, expYear: year < 100 ? 2000 + year : year };
}

/** What people call a vault item, such as "Home" or "Work card"; empty uses a default. */
export const VaultItemTitle = z.string().trim().max(80);
/** When the bot should use an item, such as "For travel". */
export const VaultItemNote = z.string().trim().max(200);

export const VAULT_ALSO_ON_LIMIT = 10;
/** The most items one vault holds. */
export const VAULT_ITEM_LIMIT = 100;

// A blocked item's value is still hidden in every run; a saved card still asks before each use.
// "ask" is for a website login: each browser_act call that signs in with it asks the user first.
export const VaultPolicy = z.enum(["allow", "off", "ask"]);
export type VaultPolicy = z.infer<typeof VaultPolicy>;

/**
 * An item the owner saves in a vault: the account's or, with scope "space", the Space's. Without a
 * name it is a new item, named from its title. With the name of a saved item, `value` may be left
 * out to change only its title or note.
 */
export const VaultPutInput = settingsScopeInput.extend({
  destination: z
    .object({ ...destinationInputShape, name: BotSecretName.optional() })
    .superRefine(requireSite),
  value: BotSecretPutInput.shape.value.optional(),
  title: VaultItemTitle.optional(),
  note: VaultItemNote.optional(),
  policy: VaultPolicy.optional(),
  /**
   * `botIds` limits the item in this Space to those of the owner's bots; `allBots` true lets every
   * bot use it and forgets the choice. Both left out, the bots stay as they are.
   */
  allBots: z.boolean().optional(),
  botIds: z.array(Id).max(100).optional(),
  /** A login's other sites; left as they are when omitted. */
  alsoOn: z.array(z.string().max(2048)).max(VAULT_ALSO_ON_LIMIT).optional(),
});
export type VaultPutInput = z.infer<typeof VaultPutInput>;

export const VaultRevealInput = settingsScopeInput.extend({ name: StoredBotSecretName });

/**
 * A saved value shown to its owner after they confirm it's them: a login's fields, a card, or the
 * value. A contact needs no reveal: its fields are in the list.
 */
export const VaultRevealed = z.union([
  z.object({
    fields: z.array(z.object({ label: z.string(), value: z.string(), hidden: z.boolean() })),
    otp: z.string().optional(),
  }),
  z.object({ card: CardSecretValue }),
  z.object({ value: z.string() }),
]);
export type VaultRevealed = z.infer<typeof VaultRevealed>;

export const VAULT_ACTIVITY_LIMIT = 20;

export const VaultUse = z.strictObject({
  at: z.string(),
  botName: z.string().max(200),
  site: z.string().max(2048).nullable(),
  chat: z.strictObject({ title: z.string() }).nullable(),
});
export type VaultUse = z.infer<typeof VaultUse>;

/** What anyone who may see the item sees of a card: never the number or security code. */
export const CardSummary = z.object({
  brand: z.string(),
  last4: z.string(),
  expMonth: z.number().int(),
  expYear: z.number().int(),
  name: z.string().optional(),
  /** The saved contact whose address bills this card. */
  billing: z.string().optional(),
});
export type CardSummary = z.infer<typeof CardSummary>;

/** What a list shows under an item's title, read from its saved value. */
export const VaultPreview = z.object({
  /** A login's first visible field, usually the username or email. */
  username: z.string().optional(),
  /** A login with an authenticator key. Missing from an older server, which can't keep one. */
  otp: z.literal(true).optional(),
  card: CardSummary.optional(),
  contact: ContactFields.optional(),
});
export type VaultPreview = z.infer<typeof VaultPreview>;

/**
 * What the owner can see about a saved credential. It never carries the protected value.
 * `name` is read loosely and `auth` is nullable so one stored row that no longer passes the
 * current schema cannot fail the whole list call and lock the owner out of removing it.
 * A null `auth` means the stored settings can't be read. `title` is never empty: one the owner
 * left empty is filled from the item itself.
 */
export const BotSecretMetadata = z.object({
  name: StoredBotSecretName,
  origin: z.string(),
  auth: BotSecretAuth.nullable(),
  title: z.string().default(""),
  note: z.string().default(""),
  preview: VaultPreview.optional(),
  /** Missing from an older server, which means "allow". */
  policy: VaultPolicy.optional(),
  /** Both missing from an older server, which lets every bot use every item. */
  allBots: z.boolean().optional(),
  /** The bots chosen in this Space while `allBots` is false; none otherwise. */
  botIds: z.array(z.string()).optional(),
  /** Missing from an older server, which fills a login only on its own site. */
  alsoOn: z.array(z.string()).optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type BotSecretMetadata = z.infer<typeof BotSecretMetadata>;

// Fixed text, so apps can show it translated: an answer's other errors could echo the value.
export const BLOCKED_ITEM_ANSWER =
  "This item is blocked for bots. Allow it in the Vault, or dismiss the request.";
/** As BLOCKED_ITEM_ANSWER, for an item allowed but limited to other bots. */
export const UNCHOSEN_ITEM_ANSWER =
  "This bot can't use this item. Change it in the Vault, or dismiss the request.";

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
