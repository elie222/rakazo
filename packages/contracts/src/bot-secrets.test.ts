import { describe, expect, it } from "vitest";
import {
  BotSecretDestination,
  BotSecretDestinationInput,
  botSecretDestinationSchema,
  commandVariableName,
  commandVariableProblem,
  decodeLoginSecret,
  encodeLoginSecret,
  LOGIN_FIELD_LIMIT,
  LoginFieldLabels,
  loginCardFields,
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

  it("starts the default card as logins always have and every named field hidden", () => {
    expect(loginCardFields(undefined)).toEqual([
      { label: "Username", value: "", hidden: false },
      { label: "Password", value: "", hidden: true },
    ]);
    // The bot can't make a field visible, not even by naming the default labels.
    expect(loginCardFields(["Username", "Password"]).map((field) => field.hidden)).toEqual([
      true,
      true,
    ]);
    expect(loginCardFields(["ID", "Phone"]).map((field) => field.hidden)).toEqual([true, true]);
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
    expect(missing.error?.issues[0]?.message).toMatch(/Expected an HTTPS origin/);
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
