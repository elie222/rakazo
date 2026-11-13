import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { INBOUND_EMAIL_HEADER_MAX_CHARS, INBOUND_EMAIL_TEXT_MAX_CHARS } from "./bot-email.js";
import {
  authenticatorKey,
  BOT_SECRET_ORIGIN_MISSING_MESSAGE,
  BotSecretDestination,
  BotSecretDestinationInput,
  botSecretDestinationSchema,
  commandVariableName,
  commandVariableProblem,
  decodeLoginSecret,
  encodeLoginSecret,
  hideOneTimeCodeInEmail,
  LOGIN_FIELD_LIMIT,
  LoginFieldLabels,
  loginCardFields,
  normalizeOneTimeCode,
  ONE_TIME_CODE_RUBRIC,
  ONE_TIME_CODE_TOKENS,
  ONE_TIME_CODE_UNIT_LIMIT,
  OneTimeCodeTarget,
  oneTimeCodeWritings,
  readOneTimeCode,
  SecretHttpRequest,
} from "./bot-secrets.js";
import { AGENT_SECRET_NAME_PATTERN } from "./domain.js";

const destination = {
  name: "example_api",
  origin: "https://api.example.test",
  auth: { type: "bearer" },
};

describe("credential contracts", () => {
  it.each([
    "http://api.example.test",
    "https://user:pass@api.example.test",
    "https://api.example.test/path",
    "https://api.example.test?query=1",
    "https://api.example.test#fragment",
  ])("rejects non-origin destination %s", (origin) => {
    expect(BotSecretDestination.safeParse({ ...destination, origin }).success).toBe(false);
  });
  it.each([undefined, ""])(
    "reports a missing origin (%j) as missing, for a login too",
    (origin) => {
      for (const auth of [{ type: "login" }, { type: "bearer" }]) {
        const result = BotSecretDestination.safeParse({ name: "example_login", origin, auth });
        expect(result.success).toBe(false);
        expect(
          result.error?.issues.map((issue) => ({ path: issue.path, message: issue.message })),
        ).toEqual([{ path: ["origin"], message: BOT_SECRET_ORIGIN_MISSING_MESSAGE }]);
      }
    },
  );
  it("keeps the origin rule message for an origin that is present but invalid", () => {
    const result = BotSecretDestination.safeParse({
      name: "example_login",
      origin: "www.example.com",
      auth: { type: "login" },
    });
    const messages = result.error?.issues.map((issue) => issue.message) ?? [];
    expect(messages).toEqual([
      "Expected an HTTPS origin without a path, credentials, query, or fragment",
    ]);
  });
  it("accepts a valid login origin, and a command variable without one", () => {
    expect(
      BotSecretDestination.safeParse({
        name: "example_login",
        origin: "https://www.example.com",
        auth: { type: "login" },
      }).success,
    ).toBe(true);
    expect(
      BotSecretDestination.safeParse({ name: "example_cmd", auth: { type: "command" } }).success,
    ).toBe(true);
  });
  it.each(["feishu-app-credentials", "my-creds-2", "team_a-bot"])(
    "accepts hyphenated credential names like %s",
    (name) => {
      expect(BotSecretDestination.safeParse({ ...destination, name }).success).toBe(true);
    },
  );
  it.each(["Feishu App", "-leading", "with space", ""])(
    "rejects malformed credential names %s",
    (name) => {
      expect(BotSecretDestination.safeParse({ ...destination, name }).success).toBe(false);
    },
  );
  it.each([
    "Host",
    "Connection",
    "Content-Length",
    "Cookie",
    "Proxy-Authorization",
    "X-Forwarded-Host",
    "Sec-Fetch-Site",
    "X-Key\r\nHost",
  ])("rejects reserved or malformed header %s", (name) => {
    expect(
      BotSecretDestination.safeParse({ ...destination, auth: { type: "header", name } }).success,
    ).toBe(false);
  });
  it.each(["GET", "HEAD"])("rejects even an empty body on %s", (method) => {
    expect(
      SecretHttpRequest.safeParse({
        name: "example_api",
        url: destination.origin,
        method,
        body: "",
      }).success,
    ).toBe(false);
  });
  it("accepts ordinary authentication and bounds request inputs", () => {
    expect(BotSecretDestination.parse(destination)).toEqual(destination);
    expect(
      BotSecretDestination.safeParse({
        ...destination,
        auth: { type: "header", name: "X-Api-Key" },
      }).success,
    ).toBe(true);
    expect(
      SecretHttpRequest.safeParse({ name: "example_api", url: destination.origin, body: "body" })
        .success,
    ).toBe(false);
    expect(
      SecretHttpRequest.safeParse({
        name: "example_api",
        url: destination.origin,
        method: "POST",
        body: "x".repeat(100_001),
      }).success,
    ).toBe(false);
  });
});

describe("private HTTP credential origins", () => {
  const relaxed = botSecretDestinationSchema({ allowPrivateHttpOrigin: true });

  it("rejects private HTTP origins by default", () => {
    expect(
      BotSecretDestination.safeParse({ ...destination, origin: "http://192.168.2.10:8080" })
        .success,
    ).toBe(false);
  });
  it.each([
    "http://192.168.2.10:8080",
    "http://10.1.2.3",
    "http://172.16.5.4",
    "http://172.31.255.254",
    "http://100.100.1.5",
    "http://localhost:3000",
    "http://nas.local",
  ])("accepts private HTTP origin %s when the owner opts in", (origin) => {
    expect(relaxed.safeParse({ ...destination, origin }).success).toBe(true);
  });
  it("still rejects public HTTP origins when the owner opts in", () => {
    expect(relaxed.safeParse({ ...destination, origin: "http://api.example.test" }).success).toBe(
      false,
    );
  });
  it("rejects a private HTTP origin for a website login even when the owner opts in", () => {
    expect(
      relaxed.safeParse({
        ...destination,
        origin: "http://192.168.2.10:8080",
        auth: { type: "login" },
      }).success,
    ).toBe(false);
    expect(relaxed.safeParse({ ...destination, auth: { type: "login" } }).success).toBe(true);
  });
  it.each([
    "http://192.168.2.10:8080/upload",
    "http://192.168.2.10:8080?key=1",
    "http://100.100.100.200",
    "http://169.254.170.2",
    "http://169.254.169.254",
  ])("relaxed schema still rejects non-origin URLs %s", (origin) => {
    expect(relaxed.safeParse({ ...destination, origin }).success).toBe(false);
  });
  it.each([
    "https://[::ffff:169.254.169.254]",
    "https://[fd00:ec2::254]",
    "https://metadata.goog.",
  ])("rejects a metadata origin in any form %s", (origin) => {
    expect(relaxed.safeParse({ ...destination, origin }).success).toBe(false);
    expect(BotSecretDestination.safeParse({ ...destination, origin }).success).toBe(false);
  });
});

describe("login credentials", () => {
  const fields = [
    { label: "ID number", value: "fake-id-123", hidden: false },
    { label: "Phone number", value: "+1 555 0100", hidden: true },
    { label: "PIN", value: " 0000 ", hidden: true },
  ];

  it("accepts a login destination and round-trips its fields in order", () => {
    expect(
      BotSecretDestination.safeParse({ ...destination, auth: { type: "login" } }).success,
    ).toBe(true);
    expect(decodeLoginSecret(encodeLoginSecret({ fields }))).toEqual({ fields });
  });

  it("writes only the fields, so a release without them fails to read a new login", () => {
    const stored = JSON.parse(encodeLoginSecret({ fields }));
    expect(Object.keys(stored)).toEqual(["fields"]);
    expect(stored).not.toHaveProperty("username");
    expect(stored).not.toHaveProperty("password");
  });

  it("reads a saved username and password as a visible Username and a hidden Password", () => {
    const legacy = JSON.stringify({
      username: "fake-user",
      password: "fake:password\nwith newline",
    });
    expect(decodeLoginSecret(legacy)).toEqual({
      fields: [
        { label: "Username", value: "fake-user", hidden: false },
        { label: "Password", value: "fake:password\nwith newline", hidden: true },
      ],
    });
  });

  it("trims visible values and labels but keeps hidden values exactly as typed", () => {
    const { fields: saved } = decodeLoginSecret(
      encodeLoginSecret({
        fields: [
          { label: " Email ", value: " fake@example.test ", hidden: false },
          { label: "Password", value: " fake password ", hidden: true },
        ],
      }),
    );
    expect(saved).toEqual([
      { label: "Email", value: "fake@example.test", hidden: false },
      { label: "Password", value: " fake password ", hidden: true },
    ]);
  });

  it.each([
    ["no fields", { fields: [] }],
    ["an empty value", { fields: [{ label: "Code", value: "", hidden: true }] }],
    ["a blank visible value", { fields: [{ label: "ID", value: "  ", hidden: false }] }],
    ["an empty label", { fields: [{ label: " ", value: "fake", hidden: true }] }],
    ["a long label", { fields: [{ label: "x".repeat(65), value: "fake", hidden: true }] }],
    ["a long value", { fields: [{ label: "Password", value: "x".repeat(4097), hidden: true }] }],
    [
      "too many fields",
      {
        fields: Array.from({ length: LOGIN_FIELD_LIMIT + 1 }, (_, index) => ({
          label: `Field ${index}`,
          value: "fake",
          hidden: true,
        })),
      },
    ],
    [
      "labels that differ only in case",
      {
        fields: [
          { label: "Code", value: "fake-1", hidden: true },
          { label: "code ", value: "fake-2", hidden: true },
        ],
      },
    ],
    ["a field without hidden", { fields: [{ label: "Password", value: "fake" }] }],
  ])("rejects a login with %s", (_, value) => {
    expect(() => encodeLoginSecret(value as never)).toThrow();
    expect(() => decodeLoginSecret(JSON.stringify(value))).toThrow();
  });

  it("rejects a login longer than a credential can be", () => {
    const value = {
      fields: Array.from({ length: 5 }, (_, index) => ({
        label: `Field ${index}`,
        value: "x".repeat(4096),
        hidden: true,
      })),
    };
    expect(() => encodeLoginSecret(value)).toThrow();
  });

  it.each([
    { username: "", password: "fake-password" },
    { username: "fake-user", password: "" },
    { username: "fake-user" },
  ])("rejects an incomplete saved pair %j", (value) => {
    expect(() => decodeLoginSecret(JSON.stringify(value))).toThrow();
  });

  it("starts the default card as logins always have", () => {
    expect(loginCardFields(undefined)).toEqual([
      { label: "Username", value: "", hidden: false },
      { label: "Password", value: "", hidden: true },
    ]);
    // Naming the default labels gives the same card, so the bot gains nothing by it.
    expect(loginCardFields(["Username", "Password"])).toEqual(loginCardFields(undefined));
  });

  it("starts an ID and a phone visible for a sign-in with no password field", () => {
    expect(loginCardFields(["ID number", "Phone number", "SMS code"])).toEqual([
      { label: "ID number", value: "", hidden: false },
      { label: "Phone number", value: "", hidden: false },
      { label: "SMS code", value: "", hidden: true },
    ]);
  });

  it.each([
    "ID",
    "ID number",
    "  id-number ",
    "Email",
    "E-mail address",
    "e/mail",
    "Email or phone",
    "Mobile phone",
    "Account number",
    "Customer ID",
    "National ID",
    "Tax ID",
    "Employee ID",
    "Login name",
    "Last 4 digits of ID",
    "Account #",
    "ID \u2116",
    "Account \u2116",
    "Acc\u200Bount",
    "PHONE",
    "Télephone",
    "ＩＤ ｎｕｍｂｅｒ",
    "תעודת זהות",
    "ת.ז.",
    "הטלפון הנייד",
    "מספר טלפון",
    "מספר חשבון",
    "\u200Fמייל\u200F",
    "שם משתמש",
  ])("starts %j visible", (label) => {
    expect(loginCardFields([label])[0]!.hidden).toBe(false);
  });

  it.each([
    "Password",
    "PIN",
    "Account PIN",
    "Phone password",
    "Email code",
    "Verification code",
    "One-time code (OTP)",
    "ID answer",
    "API key",
    "Token",
    "CVV",
    // Plurals, abbreviations and other spellings of a secret.
    "Account passwords",
    "Account PINs",
    "Account codes",
    "Account pwd",
    "Account passwd",
    "Account pw",
    "Account pincode",
    "Account credentials",
    "Account 2FA",
    "Account TOTP",
    "Account CVV2",
    // Look-alike and invisible letters.
    "Account P\u0430ssword",
    "Account \uFF30\uFF29\uFF2E",
    "Account PIN\u3164",
    "Account\u3164",
    "Account\u{1F511}",
    "Account \u{1F512}",
    "Phone \u2731\u2731\u2731",
    "ID \u{1F511} number",
    "Account +",
    // Labels we don't recognise stay hidden.
    "Memorable word",
    "Mother's maiden name",
    "Card number",
    "Date of birth",
    "Name",
    "Number",
    "Hid",
    "Provider",
    "סיסמה",
    "קוד SMS",
    "הקוד",
    "טלפון סודי",
    "קוד אימות",
    "סיסמת חשבון",
    "ססמת חשבון",
    "חשבון פין",
    "טלפון וסיסמה",
    "חשבון וקוד",
  ])("starts %j hidden", (label) => {
    expect(loginCardFields([label])[0]!.hidden).toBe(true);
  });

  it.each([[["Username", "Password"]], [["ID", "Phone", "Code"]]])(
    "accepts requested labels %j",
    (labels) => {
      expect(LoginFieldLabels.safeParse(labels).success).toBe(true);
    },
  );

  it.each([[[]], [["Code", "CODE"]], [[""]]])("rejects requested labels %j", (labels) => {
    expect(LoginFieldLabels.safeParse(labels).success).toBe(false);
  });
});

describe("command variables", () => {
  const command = { type: "command" } as const;

  it.each([
    ["netbird-setup-key", "NETBIRD_SETUP_KEY"],
    ["github_pat", "GITHUB_PAT"],
    ["a", "A"],
    ["x-1_y-2", "X_1_Y_2"],
  ])("exports %s as $%s, a valid space variable name", (name, variable) => {
    expect(commandVariableName(name)).toBe(variable);
    expect(AGENT_SECRET_NAME_PATTERN.test(variable)).toBe(true);
    expect(commandVariableProblem(variable)).toBeUndefined();
  });

  it.each([
    "PATH",
    "HOME",
    "IFS",
    "ENV",
    "BASH_ENV",
    "PROMPT_COMMAND",
    "PS4",
    "SSH_AUTH_SOCK",
    "NODE_OPTIONS",
    "NODE_TLS_REJECT_UNAUTHORIZED",
    "PYTHONPATH",
    "PERL5OPT",
    "RUBYOPT",
    "JDK_JAVA_OPTIONS",
    "HTTPS_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    "SSLKEYLOGFILE",
    "GIT_SSL_CAINFO",
    "GIT_SSL_NO_VERIFY",
    "OPENSSL_CONF",
    "OPENSSL_ENGINES",
    "OPENSSL_MODULES",
    "GIT_SSH_COMMAND",
    "GIT_PROXY_COMMAND",
    "GIT_EXTERNAL_DIFF",
    "GIT_PAGER",
    "GIT_EDITOR",
    "GIT_EXEC_PATH",
    "GIT_TEMPLATE_DIR",
    "GIT_CONFIG_GLOBAL",
    "GIT_CONFIG_SYSTEM",
    "GIT_CONFIG_COUNT",
    "GCONV_PATH",
    "NPM_CONFIG_PREFIX",
    "NPM_CONFIG_REGISTRY",
    "SSH_ASKPASS",
    "LD_PRELOAD",
    "LD_LIBRARY_PATH",
    "LD_ANYTHING",
    "DYLD_INSERT_LIBRARIES",
    "DYLD_ANYTHING",
    "RAKAZO_TOKEN",
  ])("reserves $%s", (variable) => {
    expect(commandVariableProblem(variable)).toBe("reserved");
  });

  it("reserves exact names and prefixes only", () => {
    expect(commandVariableProblem("PATHS")).toBeUndefined();
    expect(commandVariableProblem("MY_PATH")).toBeUndefined();
    expect(commandVariableProblem("OLD_LD_FLAG")).toBeUndefined();
  });

  it("marks a name outside the space variable pattern invalid", () => {
    expect(commandVariableProblem("lower")).toBe("invalid");
    expect(commandVariableProblem("1ABC")).toBe("invalid");
    expect(commandVariableProblem("A".repeat(65))).toBe("invalid");
  });

  it("accepts a command destination with a missing or empty origin", () => {
    for (const schema of [
      BotSecretDestination,
      botSecretDestinationSchema({ allowPrivateHttpOrigin: true }),
    ]) {
      expect(schema.parse({ name: "netbird-setup-key", auth: command })).toEqual({
        name: "netbird-setup-key",
        origin: "",
        auth: command,
      });
      expect(
        schema.safeParse({ name: "netbird-setup-key", origin: "", auth: command }).success,
      ).toBe(true);
    }
  });

  it("rejects a site on a command destination", () => {
    const result = BotSecretDestination.safeParse({
      name: "netbird-setup-key",
      origin: "https://api.example.test",
      auth: command,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["origin"]);
  });

  it.each([
    ["ld_preload", "$LD_PRELOAD"],
    ["dyld-insert-libraries", "$DYLD_INSERT_LIBRARIES"],
    ["path", "$PATH"],
    ["rakazo-token", "$RAKAZO_TOKEN"],
  ])("rejects %s because %s is reserved", (name, variable) => {
    const result = BotSecretDestination.safeParse({ name, auth: command });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]).toMatchObject({
      path: ["name"],
      message: expect.stringContaining(`${variable} is reserved`),
    });
  });

  it("does not reserve names for credentials that are not command variables", () => {
    expect(BotSecretDestination.safeParse({ ...destination, name: "path" }).success).toBe(true);
  });

  it.each([
    { type: "bearer" },
    { type: "header", name: "X-Api-Key" },
    { type: "basic", username: "api-user" },
    { type: "login" },
  ])("still requires a valid HTTPS origin for %j", (auth) => {
    const relaxed = botSecretDestinationSchema({ allowPrivateHttpOrigin: true });
    for (const schema of [BotSecretDestination, relaxed]) {
      expect(schema.safeParse({ name: "api", auth }).success).toBe(false);
      expect(schema.safeParse({ name: "api", origin: "", auth }).success).toBe(false);
      expect(
        schema.safeParse({ name: "api", origin: "http://api.example.test", auth }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ name: "api", origin: "https://api.example.test/path", auth }).success,
      ).toBe(false);
      expect(
        schema.safeParse({ name: "api", origin: "https://api.example.test", auth }).success,
      ).toBe(true);
    }
    const missing = BotSecretDestination.safeParse({ name: "api", auth });
    expect(missing.error?.issues[0]?.message).toBe(BOT_SECRET_ORIGIN_MISSING_MESSAGE);
  });

  it("lets the owner input omit the origin only for a command variable", () => {
    expect(BotSecretDestinationInput.parse({ name: "cli-token", auth: command })).toEqual({
      name: "cli-token",
      origin: "",
      auth: command,
    });
    expect(
      BotSecretDestinationInput.safeParse({ name: "api", auth: { type: "bearer" } }).success,
    ).toBe(false);
    expect(
      BotSecretDestinationInput.safeParse({ name: "api", origin: "", auth: { type: "bearer" } })
        .success,
    ).toBe(false);
  });
});

describe("one-time code contracts", () => {
  it.each([
    ["482913", "482913"],
    [" 482 913 ", "482913"],
    ["G-482913", "G-482913"],
    ["1234", "1234"],
    ["abcd1234efgh", "abcd1234efgh"],
    ["123-456", "123-456"],
    ["12-34-56", "12-34-56"],
  ])("takes %j as %j", (typed, code) => {
    expect(normalizeOneTimeCode(typed)).toBe(code);
  });

  it.each([
    "",
    "   ",
    "ok",
    "123",
    "x".repeat(13),
    "12 34 56 78 90 12 3",
    "----",
    "1---",
    "a-b-",
    "-1234",
    "12--34",
    "1-2-3",
    "12.34",
    "12_34",
    "١٢٣٤٥٦",
  ])("takes %j as no code", (typed) => {
    expect(normalizeOneTimeCode(typed)).toBeUndefined();
  });

  describe("reading a code out of an email", () => {
    const read = (text: string, subject = "Sign in") => readOneTimeCode({ subject, text }).code;

    it.each([
      ["six digits", "Your verification code is 482913.", "482913"],
      ["eight digits", "Code: 48291375", "48291375"],
      ["a code split by a space", "Your code: 482 913", "482913"],
      ["a code split by a dash", "Your code: 482-913", "482913"],
      ["a code split by a no-break space", "Your code: 482\u00a0913", "482913"],
      ["eight digits in two groups", "Passcode 4829 1375", "48291375"],
      ["letters and digits", "Use code K7Q2M9 to sign in.", "K7Q2M9"],
      ["a code after its cue", "482913 is your one-time password", "482913"],
      ["a code on a line of its own under its cue", "Your code:\n\n  482913\n\nThanks", "482913"],
      ["a code on a line of its own under the subject", "482913\n\nThanks", "482913", "Your code"],
      ["a code after a bracket", "Your code is 482913 (valid 10 minutes)", "482913"],
      ["a code before a sentence about something else", "Code 731905. Order 48213977", "731905"],
      ["a code after a sentence about something else", "Order 48213977. Code 731905", "731905"],
      ["a code with an order in brackets", "Code 731905 (order 48213977)", "731905"],
      ["a code before a comma clause", "Code 731905, order 48213977", "731905"],
      ["a code under an order line", "Order 48213977\nYour code:\n731905", "731905"],
      ["a code with an apostrophe", "Here's your code: 482913", "482913"],
      [
        "a code after a ticket sentence",
        "Ticket 48213977 is ready. Your code is 731905.",
        "731905",
      ],
    ])("finds %s", (_name, text, code, subject?: string) => {
      expect(read(text, subject)).toBe(code);
    });

    // The forms a sentence may take to give a code, in each shipped language: "<cue> is <code>",
    // "<cue>: <code>", "<code> is your <cue>", and a line naming a code over a line of the code.
    const TEMPLATES: [language: string, texts: string[]][] = [
      [
        "en",
        [
          "Your verification code is 482913.",
          "Verification code: 482913",
          "Sign-in code - 482913",
          "Code = 482913",
          "482913 is your verification code.",
          "Enter the one-time PIN 482913 to sign in.",
          "Your security code:\n482913",
        ],
      ],
      [
        "de",
        [
          "Ihr Bestätigungscode lautet 482913.",
          "Bestätigungscode: 482913",
          "482913 ist Ihr Anmeldecode.",
          "Dein Einmalpasswort:\n482913",
        ],
      ],
      [
        "es",
        [
          "Tu código de verificación es 482913.",
          "Código de verificación: 482913",
          "482913 es tu código de acceso.",
          "Tu código:\n482913",
        ],
      ],
      [
        "fr",
        [
          "Votre code de vérification est 482913.",
          "Code de connexion : 482913",
          "482913 est votre code de sécurité.",
          "Mot de passe à usage unique : 482913",
          "Votre code d'accès :\n482913",
        ],
      ],
      [
        "he",
        [
          "קוד האימות שלך הוא 482913",
          "קוד אימות: 482913",
          "482913 הוא קוד הכניסה שלך",
          "הקוד שלך:\n482913",
        ],
      ],
      [
        "hi",
        [
          "आपका सत्यापन कोड 482913 है।",
          "सत्यापन कोड: 482913",
          "482913 आपका लॉगिन कोड है",
          "आपका कोड:\n482913",
        ],
      ],
      [
        "ja",
        [
          "認証コードは482913です。",
          "確認コード：482913",
          "482913があなたの認証コードです",
          "認証コード\n482913",
        ],
      ],
      [
        "ko",
        [
          "인증번호는 482913입니다.",
          "확인코드: 482913",
          "482913은 회원님의 인증 코드입니다",
          "인증 코드:\n482913",
        ],
      ],
      [
        "nl",
        [
          "Je verificatiecode is 482913.",
          "Verificatiecode: 482913",
          "482913 is je inlogcode.",
          "Je code:\n482913",
        ],
      ],
      [
        "pl",
        [
          "Twój kod weryfikacyjny to 482913.",
          "Kod weryfikacyjny: 482913",
          "482913 to twój kod logowania.",
          "Twój kod:\n482913",
        ],
      ],
      [
        "pt-BR",
        [
          "Seu código de verificação é 482913.",
          "Código de verificação: 482913",
          "482913 é o seu código de acesso.",
          "Seu código:\n482913",
        ],
      ],
      [
        "ru",
        [
          "Ваш код подтверждения: 482913",
          "Ваш код подтверждения — 482913",
          "482913 — ваш код для входа",
          "Ваш код:\n482913",
        ],
      ],
      [
        "tr",
        [
          "Doğrulama kodunuz: 482913",
          "Doğrulama kodunuz 482913",
          "482913 giriş kodunuz",
          "Kodunuz:\n482913",
        ],
      ],
      [
        "zh-CN",
        [
          "您的验证码是482913，5分钟内有效。",
          "验证码：482913",
          "482913是您的登录验证码",
          "您的验证码：\n482913",
        ],
      ],
      [
        "zh-TW",
        [
          "您的驗證碼為482913。",
          "驗證碼：482913",
          "482913是您的登入驗證碼",
          "您的驗證碼：\n482913",
        ],
      ],
    ];
    it.each(TEMPLATES.flatMap(([language, texts]) => texts.map((text) => [language, text])))(
      "finds a code written in a template in %s: %j",
      (_language, text) => {
        expect(read(text, "Hello")).toBe("482913");
        // The same form in the subject.
        if (!text.includes("\n")) expect(read("Hello", text)).toBe("482913");
      },
    );

    // In every language with code words: a sentence naming a code with a word saying it is old,
    // previous, expired or invalid makes the email give none, whatever else that sentence says;
    // one saying when the code will expire does not. `wrapped` is such a sentence over two lines,
    // the code word on the first and the stale word on the second, as plain-text mail wraps it.
    const STALE: [
      language: string,
      code: string,
      stale: string,
      expires: string,
      wrapped: string,
    ][] = [
      [
        "en",
        "Your verification code is 482913.",
        "Your previous code has expired.",
        "This code expires in 10 minutes.",
        "This code has\nexpired.",
      ],
      [
        "de",
        "Ihr Bestätigungscode lautet 482913.",
        "Der alte Code ist abgelaufen.",
        "Der Code läuft in 10 Minuten ab.",
        "Dieser Code ist\nabgelaufen.",
      ],
      [
        "es",
        "Tu código de verificación es 482913.",
        "El código anterior ha caducado.",
        "El código caduca en 10 minutos.",
        "Este código ha\ncaducado.",
      ],
      [
        "fr",
        "Votre code de vérification est 482913.",
        "Ce code a expiré.",
        "Ce code expire dans 10 minutes.",
        "Ce code a\nexpiré.",
      ],
      [
        "nl",
        "Je verificatiecode is 482913.",
        "De vorige code is verlopen.",
        "De code verloopt over 10 minuten.",
        "Deze code is\nverlopen.",
      ],
      [
        "pl",
        "Twój kod weryfikacyjny to 482913.",
        "Poprzedni kod wygasł.",
        "Kod wygaśnie za 10 minut.",
        "Ten kod\nwygasł.",
      ],
      [
        "pt",
        "Seu código de verificação é 482913.",
        "O código anterior expirou.",
        "O código expira em 10 minutos.",
        "Este código\nexpirou.",
      ],
      [
        "ru",
        "Ваш код подтверждения: 482913",
        "Предыдущий код истёк.",
        "Код истекает через 10 минут.",
        "Этот код\nистёк.",
      ],
      [
        "tr",
        "Doğrulama kodunuz: 482913",
        "Önceki kod geçersiz.",
        "Bu kod 10 dakika geçerlidir.",
        "Bu kod\ngeçersiz.",
      ],
      [
        "hi",
        "आपका सत्यापन कोड 482913 है।",
        "पिछला कोड समाप्त हो गया।",
        "यह कोड 10 मिनट में समाप्त हो जाएगा।",
        "यह कोड\nसमाप्त हो गया।",
      ],
      [
        "he",
        "קוד האימות שלך הוא 482913",
        "הקוד הקודם פג תוקף.",
        "הקוד יפוג בעוד 10 דקות.",
        "הקוד הזה\nפג תוקף.",
      ],
      [
        "ja",
        "認証コードは482913です。",
        "以前のコードは期限切れです。",
        "このコードは10分後に無効になります。",
        "このコードは\n期限切れです。",
      ],
      [
        "ko",
        "인증번호는 482913입니다.",
        "이전 코드는 만료되었습니다.",
        "이 코드는 10분 후에 만료됩니다.",
        "이 코드는\n만료되었습니다.",
      ],
      [
        "zh-CN",
        "您的验证码是482913。",
        "之前的验证码已过期。",
        "验证码10分钟内有效。",
        "此验证码\n已过期。",
      ],
      [
        "zh-TW",
        "您的驗證碼為482913。",
        "之前的驗證碼已過期。",
        "驗證碼10分鐘內有效。",
        "此驗證碼\n已過期。",
      ],
    ];
    /** Words no list holds, with no sentence mark: `count` of them run past any length cap. */
    const filler = (count: number) => "lorem ".repeat(count).trim();
    it.each(STALE)(
      "in %s, gives no code beside a sentence saying the code expired, only beside when it will",
      (_language, code, stale, expires) => {
        expect(read(`${code}\n${stale}`)).toBeUndefined();
        expect(read(`${code} ${stale}`)).toBeUndefined();
        expect(read(code, stale)).toBeUndefined();
        expect(read(`${code}\n${expires}`)).toBe("482913");
      },
    );

    // The rule: a stale word applies to a code word in the same sentence, however long the
    // sentence is. A sentence ends at sentence or clause punctuation or a blank line, not at a
    // line break, as mail wraps sentences over lines.
    it.each(STALE)(
      "in %s, a sentence saying the code expired counts however long it is or its lines wrap",
      (_language, code, stale, _expires, wrapped) => {
        const [codeLine, staleLine] = wrapped.split("\n") as [string, string];
        const unmarked = (sentence: string) => sentence.replace(/[.。।]$/u, "");
        // The notice runs on without a sentence mark, past the cap on a unit that gives a code.
        const long = `${unmarked(stale)} ${filler(40)}`;
        expect(long.length).toBeGreaterThan(ONE_TIME_CODE_UNIT_LIMIT);
        expect(read(`${code}\n${long}`)).toBeUndefined();
        expect(read(`${code}\n${filler(40)} ${stale}`)).toBeUndefined();
        expect(read(code, long)).toBeUndefined();
        // Wrapped over two lines, short and long, the code word far from the stale word.
        expect(read(`${code}\n${wrapped}`)).toBeUndefined();
        const apart = `${codeLine} ${filler(60)}\n${filler(60)} ${staleLine}`;
        expect(read(`${code}\n${apart}`)).toBeUndefined();
        // A stale word in another sentence or another paragraph of a long block is about
        // something else: the code is still read.
        const block = `${filler(40)} ${codeLine}`;
        expect(read(`${code}\n\n${block}\n\n${staleLine} ${filler(40)}`)).toBe("482913");
        expect(read(`${code}\n${block}. ${unmarked(staleLine)} ${filler(40)}.`)).toBe("482913");
      },
    );

    // Case is folded without a locale: JavaScript's own folding leaves the Turkish dotted capital
    // İ and the dotless ı apart from i, and a decomposed accent apart from its letter.
    it.each<[name: string, text: string, code: string | undefined]>([
      ["an expired notice in Turkish capitals", "Kodunuz: 482913\nÖNCEKİ KOD GEÇERSİZ.", undefined],
      ["an old code in Turkish capitals", "Kodunuz: 482913\nESKİ KODUN SÜRESİ DOLDU.", undefined],
      [
        "a Turkish notice lowercased by a mailer",
        "Kodunuz: 482913\nönceki\u0307 kod geçersi\u0307z.",
        undefined,
      ],
      [
        "a French notice with decomposed accents",
        "Code: 482913\nCe code a expire\u0301.",
        undefined,
      ],
      ["a Turkish sign-in code in capitals", "GİRİŞ KODUNUZ: 482913", "482913"],
      ["a Turkish one-time password in capitals", "TEK KULLANIMLIK ŞİFRE: 482913", "482913"],
      ["a Turkish one-time password", "Tek kullanımlık şifre: 482913", "482913"],
    ])("reads %s whatever case its letters are in", (_name, text, code) => {
      expect(read(text)).toBe(code);
    });

    // An email that gives no code either names none, and says nothing of the site's other
    // emails, or is unclear: it names a code that cannot be taken, so theirs are in doubt.
    const past = (text: string) => `${text}\n${"x".repeat(INBOUND_EMAIL_TEXT_MAX_CHARS)}`;
    it.each<[name: string, text: string, unclear: boolean]>([
      ["names no code", "Welcome! Your account is ready.", false],
      ["names an order, not a code", "Order 48213977 confirmed.", false],
      ["writes a code in a form that is not read", "Your code is roughly 482913", false],
      ["holds two codes", "Your code is 482913. Your code is 731905.", true],
      ["holds a code too short to take", "Your code: 4829", true],
      ["says a code expired", "Your previous code has expired.", true],
      ["says a code expired and gives another", "Your old code expired.\nYour code: 482913", true],
      // Only the first part of a long email is read: one that names a code there may go on to
      // take it back, one that names none there is a newsletter, not a sign-in email.
      ["names no code and is longer than is read", past("Our autumn sale starts today."), false],
      ["gives a code and is longer than is read", past("Your code is 482913."), true],
      ["says a code expired and is longer than is read", past("This code has expired."), true],
    ])("says an email that %s is unclear: %s", (_name, text, unclear) => {
      expect(readOneTimeCode({ subject: "Hello", text })).toEqual({ unclear });
    });

    // The calibration set of the rubric: TEMPLATES (emails that give their code) and STALE
    // (emails that give none, and the look-alikes that do) above, read by the tests around them.
    it("has calibration emails, giving a code and giving none, in every language it reads", () => {
      const calibrated = (rows: readonly (readonly [string, ...unknown[]])[]) =>
        new Set(rows.map(([language]) => language.split("-")[0]));
      const languages = ONE_TIME_CODE_RUBRIC.languages.map(({ language }) => language).sort();
      expect([...calibrated(TEMPLATES)].sort()).toEqual(languages);
      expect([...calibrated(STALE)].sort()).toEqual(languages);
    });

    it("takes a new version whenever a word list, a form or a limit changes", () => {
      // Changed a list, a form or a limit? Add its emails to the calibration set, raise
      // ONE_TIME_CODE_RUBRIC_VERSION, and pin the new version and digest here.
      const digest = createHash("sha256")
        .update(JSON.stringify(ONE_TIME_CODE_RUBRIC))
        .digest("hex");
      expect({ version: ONE_TIME_CODE_RUBRIC.version, digest }).toEqual({
        version: 1,
        digest: "12c02f3736ba7ee58bd7ea020117ecb6269b87353d2a22941c0dc16337141003",
      });
    });

    it("gives no code from a subject as long as the inbox keeps, which it may have cut", () => {
      const sentence = "Your code is 482913.";
      const cut = `${sentence} ${"x ".repeat(INBOUND_EMAIL_HEADER_MAX_CHARS)}Your code is 731905.`;
      // As the inbox stores it: the second code is gone, so the first is not taken for the only one.
      const stored = cut.slice(0, INBOUND_EMAIL_HEADER_MAX_CHARS);
      expect(stored).not.toContain("731905");
      expect(readOneTimeCode({ subject: stored, text: "Hello" })).toEqual({ unclear: true });
      expect(readOneTimeCode({ subject: cut, text: "Hello" })).toEqual({ unclear: true });
      expect(readOneTimeCode({ subject: stored, text: sentence })).toEqual({ unclear: true });
      // One short of that was never cut.
      const whole = `${sentence} ${"x ".repeat(INBOUND_EMAIL_HEADER_MAX_CHARS)}`.slice(
        0,
        INBOUND_EMAIL_HEADER_MAX_CHARS - 1,
      );
      expect(readOneTimeCode({ subject: whole, text: "Hello" }).code).toBe("482913");
    });

    it("reads no more of a subject or a text than the length the inbox keeps", () => {
      const sentence = "Your code is 482913.";
      const filler = (length: number) => `\n${"x ".repeat(length / 2)}\n`;
      // The code sentence starts inside what is read and ends outside it: not read as a code.
      const late = `Hello.${filler(INBOUND_EMAIL_TEXT_MAX_CHARS - 18)}${sentence}`;
      expect(late.indexOf("482913")).toBe(INBOUND_EMAIL_TEXT_MAX_CHARS + 3);
      expect(readOneTimeCode({ subject: "Hello", text: late })).toEqual({ unclear: false });
      expect(readOneTimeCode({ subject: late, text: "Hello" })).toEqual({ unclear: false });
      // The same sentence wholly inside what is read is the email's code, until the email is
      // longer than is read: then what follows it is not known.
      const early = `${sentence}${filler(INBOUND_EMAIL_TEXT_MAX_CHARS - 40)}`;
      expect(early.length).toBeLessThanOrEqual(INBOUND_EMAIL_TEXT_MAX_CHARS);
      expect(readOneTimeCode({ subject: "Hello", text: early }).code).toBe("482913");
      const longer = `${early}${"x".repeat(40)}`;
      expect(longer.length).toBeGreaterThan(INBOUND_EMAIL_TEXT_MAX_CHARS);
      expect(readOneTimeCode({ subject: "Hello", text: longer })).toEqual({ unclear: true });
    });

    it("is clear about the one code an email gives", () => {
      expect(readOneTimeCode({ subject: "Sign in", text: "Your code is 482913." })).toEqual({
        code: "482913",
        unclear: false,
      });
    });

    // Every sentence that is not one of the templates gives nothing, whatever stands near the
    // number: each counter-example from every review round so far is a row.
    const NEGATIVES: [name: string, text: string, subject?: string][] = [
      ["an order number before a code word", "48213977 is your order. Enter the code below"],
      ["an order number named after it", "48213977 is your order number. Your code: x"],
      ["an order number after a code line", "Your code is below. Order no. 48213977"],
      [
        "an order number between cue and code",
        "Your verification code for order 48213977 is 731905",
      ],
      [
        "an order number between cue and code in Spanish",
        "Tu código de verificación para el pedido 48213977 es 731905",
      ],
      ["an order number under a cue line", "Your code is below.\nOrder number\n48213377\n"],
      ["an order word touching the number", "Order 48213977 confirmed", "Hello"],
      ["a reference before a verification word", "ref 48213977 - verification pending"],
      ["a reference touching the number", "48213977 - ref. Your code: x"],
      ["a tracking number named by a code word", "Tracking code: 48213977"],
      ["a tracking number as a code (French)", "Code de suivi 48213977"],
      ["a tracking number before a cue (French)", "Numéro de suivi 48213977 code de vérification"],
      ["a tracking number (Dutch)", "Volgnummer 48213977 verificatiecode"],
      ["a tracking number (Hebrew)", "מספר מעקב 48213977 קוד אימות"],
      ["a tracking number before a cue", "Tracking 48213977 verification code"],
      ["a ZIP code", "ZIP code: 94043"],
      ["a ZIP code of eight digits", "ZIP code 48213977"],
      ["a postal code (French)", "Code postal 48213977"],
      ["a postcode", "Postcode: 48213977"],
      ["a postal code with no cue", "Mountain View, CA 94043"],
      ["a promo code", "Use promo code SAVE2026 at checkout."],
      ["a promo code with digits only", "Promo code: 48213977"],
      ["a discount code", "Discount code 48213977"],
      ["a coupon code", "Coupon code 48213977"],
      ["a QR code", "QR code 48213977"],
      ["a country code", "Country code 482913"],
      ["an area code", "Area code 482913"],
      ["an error code", "Error code 482913"],
      ["a status code", "Status code 482913"],
      ["a PIN code for a postal area", "PIN code 482913"],
      ["a codec", "Video codec 482913"],
      ["decoding", "Decode 482913 to continue."],
      ["an encoding", "Encoded as 482913."],
      ["a barcode", "Barcode 48213977"],
      ["a barcode named by a code word", "48213977 is your barcode"],
      ["a codec in Russian", "Кодек 482913"],
      ["an encoding in Polish", "Kodowanie 482913"],
      ["an encoding in Turkish", "Kodlama 482913"],
      ["a barcode in Hebrew", "ברקוד 48213977"],
      ["a barcode in Japanese", "バーコード：48213977"],
      ["a QR code in Japanese", "QRコード 48213977"],
      ["a barcode in Korean", "바코드 48213977"],
      ["a shorter number between cue and value", "Code 123, value 48213977"],
      ["a shorter number between cue and value, no comma", "Code 123 value 48213977"],
      ["a longer number between cue and value", "Code 482913755 then 48213977"],
      ["a number between cue and value", "Your code 1 of 2 is 482913"],
      ["a lone number line with no cue", "Hi,\n\n  482913\n\nThanks"],
      ["a lone number line under an order word", "Order number\n48213377\n"],
      ["a lone number line not right under the subject", "Hi,\n\n  482913\n\nThanks", "Your code"],
      ["a lone number line over its cue", "Hi,\n482913\nEnter this code to sign in."],
      [
        "a lone number line under a subject naming an order too",
        "48213977\n\nThanks",
        "Your order and sign-in code",
      ],
      ["a cue line followed by a line with more than the code", "Your code:\n482913 for order 5"],
      ["a cue line and a code two lines down", "Your code:\nHi\n482913"],
      ["two codes", "Your code is 482913. Your old code 731905 expired."],
      ["an expired code alone", "Your old code 731905 has expired."],
      [
        "a code and then a sentence saying the code expired",
        "Your verification code is 482913. This code has expired.",
      ],
      [
        "a code and then a line saying the code is invalid",
        "Your code is 482913.\nThe code is invalid.",
      ],
      ["a code under a subject saying the code expired", "Code: 482913", "Your code has expired"],
      [
        "a code in the subject over an expired notice in a line past the cap",
        `This code has expired ${"x".repeat(181)}`,
        "Your code: 482913",
      ],
      // On purpose: the rule does not judge what the stale word is about, so the card opens.
      [
        "a code beside a sentence naming the previous page",
        "Your verification code is 482913. Enter this code on the previous page.",
      ],
      ["a previous code alone", "Your previous code: 731905 expired. Request a new one."],
      ["an expired code alone, in German", "Ihr alter Code 731905 ist abgelaufen."],
      ["an expired code alone, in Spanish", "Su código anterior 731905 ha caducado."],
      ["an expired code alone, in French", "Votre ancien code 731905 a expiré."],
      ["an expired code alone, in Dutch", "Uw oude code 731905 is verlopen."],
      ["an expired code alone, in Polish", "Twój poprzedni kod 731905 wygasł."],
      ["an expired code alone, in Portuguese", "Seu código anterior 731905 expirou."],
      ["an expired code alone, in Russian", "Ваш старый код 731905 истёк."],
      ["an expired code alone, in Turkish", "Eski kodunuz 731905 süresi doldu."],
      ["an expired code alone, in Hindi", "आपका पुराना कोड 731905 समाप्त हो गया है।"],
      ["an expired code alone, in Hebrew", "הקוד הישן שלך 731905 פג תוקף."],
      ["an expired code alone, in Japanese", "以前のコード731905は期限切れです。"],
      ["an expired code alone, in Korean", "이전 코드 731905는 만료되었습니다."],
      ["an expired code alone, in Chinese", "您之前的验证码731905已过期。"],
      ["two codes, one in the subject", "Your code is 731905.", "Your code is 482913"],
      ["two codes in one sentence", "Your code is 482913 or 731905"],
      ["an unknown word after the code", "Your code is 482913 unless you did not ask"],
      ["an unknown word between cue and code", "Your code is roughly 482913"],
      ["an unknown word before the cue", "Shipping code 482913"],
      ["a number with no cue", "Enter 4829 to continue."],
      ["a number with no cue and no name", "48213977 - use this at checkout"],
      ["a cue with nothing but a word that is not a number", "Your code is below"],
      ["a cue in a sentence about something else", "A code was sent to 48213977"],
      ["a ticket after a code sentence with no code", "Your code expires soon. Ticket 48213977"],
      ["a code word in the subject only", "Welcome back.", "Order 482913 confirmed"],
      ["a year", "Your code is 2026"],
      ["a date", "Sent on 2026-11-10 at 10:30."],
      ["a phone number", "Not you? Call +1 (555) 123-4567 or 555 123 4567."],
      ["an amount", "You paid $1234.56, or 1,234.56 EUR."],
      ["a number in a link", "Verify at https://example.test/verify?token=482913&id=5512"],
      ["three digits", "Code 123."],
      ["full-width digits", "Your code is \uff14\uff18\uff12\uff19\uff11\uff13"],
      ["nine digits", "Code 482913755."],
      ["lowercase letters and digits", "Code abc123."],
      ["an email with no code", "Thanks for signing up. Click the link to confirm your address."],
    ];
    it.each(NEGATIVES)("gives nothing for %s", (_name, text, subject = "Hello") => {
      expect(read(text, subject)).toBeUndefined();
      // The same in the subject.
      if (!text.includes("\n") && subject === "Hello") expect(read("Hello", text)).toBeUndefined();
    });

    // What a code may look like: 6 to 8 digits, two equal digit groups split by a space or a dash,
    // or 6 to 8 capital letters and digits with both. Nothing else is one, in any case.
    it.each<[written: string, code: string | undefined]>([
      ["482913", "482913"],
      ["48291357", "48291357"],
      ["482 913", "482913"],
      ["482-913", "482913"],
      ["4829-1357", "48291357"],
      ["ABC123", "ABC123"],
      ["7Q2M9K4", "7Q2M9K4"],
      ["abc123", undefined],
      ["AbC123", undefined],
      ["deadbeef", undefined],
      ["deadbeef12", undefined],
      ["a1b2c3", undefined],
      ["ABCDEFG", undefined],
      ["HELLOWORLD", undefined],
      ["ABC1234567", undefined],
      ["482913755", undefined],
      ["48.29.13", undefined],
      ["4829 13", undefined],
      ["48 29 13", undefined],
      ["482913kg", undefined],
      ["482913 kg", undefined],
      ["2026", undefined],
      ["$482913", undefined],
      ["482913€", undefined],
      ["+1 555 123 4567", undefined],
      ["555-123-4567", undefined],
    ])("reads %s written after a code word as the code %s", (written, code) => {
      expect(read(`Your verification code is ${written}`)).toBe(code);
      expect(read(`${written} is your verification code`)).toBe(code);
    });

    // Words are read in any case, a code only in capitals: the code's pattern alone has no `i`.
    it.each<[text: string, subject?: string]>([
      ["Code abc123."],
      ["CODE abc123."],
      ["Your verification code is abc123"],
      ["abc123 is your sign-in code"],
      ["Your code:\nabc123"],
      ["Hello", "Your code: abc123"],
      ["Code aBC123."],
    ])("never makes lowercase strings sign-in codes: %s", (text, subject) => {
      expect(read(text, subject)).toBeUndefined();
      // The same in capitals is a code, whatever case its words are in.
      const capitals = (value: string) => value.replace(/abc123/i, "ABC123");
      expect(read(capitals(text), subject && capitals(subject))).toBe("ABC123");
      const [, codePattern] = ONE_TIME_CODE_TOKENS.find(([kind]) => kind === "N")!;
      expect(codePattern.ignoreCase).toBe(false);
    });

    it.each([
      ["four digits", "Your code: 4829"],
      ["five digits", "Code 48291, valid for 10 minutes."],
    ])("takes no code of %s, which could not be hidden on its own", (_name, text) => {
      expect(read(text)).toBeUndefined();
      expect(read("Welcome back.", text)).toBeUndefined();
      // Still a second code, so the email is not read as holding one.
      expect(read(`${text}\nYour code is 731905.`)).toBeUndefined();
    });

    it.each([
      ["a passcode", "Your passcode: 482913"],
      ["a code next to Han text", "您的code是482913"],
      ["a German security code", "Ihr Sicherheitscode: 482913"],
      ["a German sign-in code", "Dein Anmeldecode lautet 482913."],
      ["a Dutch sign-in code", "Je inlogcode is 482913."],
      ["a Russian PIN code", "Ваш пин-код: 482913"],
      ["a Russian code in another case", "Войдите с кодом 482913"],
      ["a Polish code in another case", "Zaloguj się kodem 482913"],
      ["a Hebrew code with its article", "הקוד שלך: 482913"],
      ["a Japanese confirmation code", "確認コード：482913"],
      ["a Korean confirmation code", "확인코드: 482913"],
    ])("still finds %s", (_name, text) => {
      expect(read(text)).toBe("482913");
    });

    it("reads a sentence about something else next to a code sentence as nothing", () => {
      expect(read("Your order 12345 has shipped.\nYour code is 731905.")).toBe("731905");
      expect(read("Use promo code SAVE2026 at checkout.\nYour code is 731905.")).toBe("731905");
      expect(read("Account 482913755.\nYour code is 731905.")).toBe("731905");
      expect(read("© 2026 Example Inc. All rights reserved.\nYour code is 731905.")).toBe("731905");
    });

    it("finds the code in the subject, also when the text repeats it", () => {
      expect(read("Welcome back.", "482913 is your sign-in code")).toBe("482913");
      expect(read("Your code is 482 913.", "482913 is your sign-in code")).toBe("482913");
    });

    it.each([
      ["six digits", "Your code: 482913", "482913"],
      ["eight digits", "Your code: 48291375", "48291375"],
      ["six digits spaced", "Your code: 482 913", "482 913"],
      ["six digits dashed", "Your code: 482-913", "482-913"],
      ["eight digits spaced", "Your code: 4829 1375", "4829 1375"],
      ["eight digits dashed", "Your code: 4829-1375", "4829-1375"],
      ["letters and digits", "Your code: K7Q2M9", "K7Q2M9"],
    ])("names %s as written among the code's writings", (_name, text, written) => {
      for (const email of [
        { subject: "Sign in", text },
        { subject: text, text: "Welcome back." },
      ]) {
        const { code } = readOneTimeCode(email);
        expect(code).toBe(written.replace(/[ -]/g, ""));
        expect(oneTimeCodeWritings(code!)).toContain(written);
      }
    });

    describe("costs a bounded number of regex runs per unit of text", () => {
      const execs = (email: { subject: string; text: string }) => {
        const exec = vi.spyOn(RegExp.prototype, "exec");
        try {
          readOneTimeCode(email);
          return exec.mock.calls.length;
        } finally {
          exec.mockRestore();
        }
      };

      it("quantifies no group in any token pattern, so none backtracks into a nested loop", () => {
        for (const [, pattern] of ONE_TIME_CODE_TOKENS) {
          expect(pattern.sticky).toBe(true);
          expect(pattern.source).not.toMatch(/\)[*+{]/);
        }
      });

      it("reads no unit longer than the cap, however it is written", () => {
        const long = `Your code is ${"really ".repeat(30)}482913`;
        expect(long.length).toBeGreaterThan(ONE_TIME_CODE_UNIT_LIMIT);
        expect(read(long)).toBeUndefined();
        const fillers = `${"your ".repeat(40)}code: 482913`;
        expect(fillers.length).toBeGreaterThan(ONE_TIME_CODE_UNIT_LIMIT);
        expect(read(fillers)).toBeUndefined();
        expect(read(`${"your ".repeat(36)}code: 482913`)).toBe("482913");
      });

      it.each([
        ["filler words", `${"a ".repeat(99)}a`],
        ["naming words and numbers", "order 48213977 code 482913 ref 731905"],
        ["unknown words", "x".repeat(ONE_TIME_CODE_UNIT_LIMIT)],
        [
          "a code word and a stale word far apart",
          `code ${"x".repeat(250)} old ${"x".repeat(250)}.`,
        ],
        ["a code line under a cue line", "Your code:\n482913"],
      ])("runs at most a fixed number of regexes per unit of %s", (_name, unit) => {
        const text = (count: number) => Array.from({ length: count }, () => unit).join("\n");
        const count = (units: number) => execs({ subject: "Hello", text: text(units) });
        // As many units as an email may hold, and half of them.
        const most = Math.floor(INBOUND_EMAIL_TEXT_MAX_CHARS / (unit.length + 1));
        const half = Math.floor(most / 2);
        // Each unit past the first adds the same number of runs: no unit reads past its own text
        // and the line below it, and a stale word is looked for once in each sentence.
        const one = count(2) - count(1);
        expect(count(half + 1) - count(half)).toBe(one);
        expect(count(most) - count(half)).toBe((most - half) * one);
        // At most the token patterns once per character, plus the splits and the form checks.
        expect(one).toBeLessThanOrEqual(
          ONE_TIME_CODE_UNIT_LIMIT * (ONE_TIME_CODE_TOKENS.length + 1) + 8,
        );
      });
    });
  });

  describe("hiding a taken code in email text", () => {
    it.each([
      ["as is", "482913"],
      ["with a no-break space", "482\u00a0913"],
      ["with a narrow no-break space", "482\u202f913"],
      ["with dots", "4.8.2.9.1.3"],
      ["with a double space", "482  913"],
      ["on separate lines", "4\n8\n2\n9\n1\n3"],
      ["with a middle dot and an en dash", "48·29–13"],
    ])("hides it written %s", (_name, written) => {
      expect(hideOneTimeCodeInEmail(`Code: ${written}!`, "482913")).toBe("Code: [redacted]!");
    });

    it("hides letters in either case, and nothing but the code's characters in order", () => {
      expect(hideOneTimeCodeInEmail("k7 q2 M9", "K7Q2M9")).toBe("[redacted]");
      expect(hideOneTimeCodeInEmail("4829, 13 and 482_913", "482913")).toBe("4829, 13 and 482_913");
    });

    it("reads a run of separators once per code character, as none is one", () => {
      // A match attempt that reads a separator run started within the code's length before it:
      // no code character is a separator, so an attempt cannot start inside the run.
      for (const character of ["a", "Z", "9"]) {
        expect(hideOneTimeCodeInEmail(`4${character}4`, "44")).toBe(`4${character}4`);
      }
      const text = `${"4".repeat(5)}${" ".repeat(200_000)}x`;
      expect(hideOneTimeCodeInEmail(text, "444444")).toBe(text);
    });
  });

  it("is for an HTTPS origin only, never a path, credentials or plain HTTP", () => {
    expect(OneTimeCodeTarget.safeParse({ origin: "https://login.example.test" }).success).toBe(
      true,
    );
    for (const origin of [
      "http://login.example.test",
      "http://192.168.1.20",
      "https://user:pass@example.test",
      "https://login.example.test/verify",
      "",
    ]) {
      expect(OneTimeCodeTarget.safeParse({ origin }).success).toBe(false);
    }
  });
});

describe("authenticatorKey", () => {
  // RFC 6238's test key, "12345678901234567890" in base32, written in pieces so it never reads
  // as a saved secret.
  const K = ("GEZDGNBV" + "GY3TQOJQ").repeat(2);
  // As issuers hand keys out, and as a slip of the finger changes them.
  it.each([
    ["a plain key", K, K],
    [
      "lower case, in groups of four",
      K.toLowerCase()
        .replace(/(.{4})/g, "$1 ")
        .trim(),
      K,
    ],
    ["dashed", K.replace(/(.{4})/g, "$1-").slice(0, -1), K],
    ["26 characters, unpadded", `${K}GEZDGNBVGY`, `${K}GEZDGNBVGY`],
    ["26 characters, padded", `${K}GEZDGNBVGY======`, `${K}GEZDGNBVGY`],
    ["a setup link", `otpauth://totp/Example:alice?secret=${K}&issuer=Example`, K],
    [
      "a setup link with its own digits, period and algorithm",
      `otpauth://totp/x?secret=${K}&digits=8&period=60&algorithm=SHA512`,
      K,
    ],
    ["one character too many", `${K}G`, undefined],
    ["three characters over a whole group", `${K}GEZ`, undefined],
    ["six characters over a whole group", `${K}GEZDGN`, undefined],
    ["a letter base32 doesn't use", `${K.slice(0, -1)}1`, undefined],
    ["too short to be a secret", "GEZDGNBV", undefined],
    ["padding where none belongs", `${K}====`, undefined],
    ["padding of the wrong length", `${K}GEZDGNBVGY====`, undefined],
    ["a whole group of padding", `${K}========`, undefined],
    ["a setup link without a secret", "otpauth://totp/Example:alice?issuer=Example", undefined],
    ["a counter-based setup link", `otpauth://hotp/x?secret=${K}`, undefined],
  ])("%s", (_, text, secret) => {
    expect(authenticatorKey(text)?.secret).toBe(secret);
  });

  it("refuses a login whose key no save accepts", () => {
    const fields = [{ label: "Password", value: "fake-pass", hidden: true }];
    expect(() => decodeLoginSecret(JSON.stringify({ fields, otp: `${K}G` }))).toThrow();
    expect(decodeLoginSecret(JSON.stringify({ fields, otp: K }))).toEqual({ fields, otp: K });
  });
});
