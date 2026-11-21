import type { BotSecretDestination, LoginPasskey } from "@rakazo/contracts";
import { BOT_SECRET_VALUE_MAX_LENGTH, decodeLoginSecret } from "@rakazo/contracts";
import { REDACTED_MARKER, redactSecrets, redactSecretsAfter } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import {
  listVaultItems,
  loadLoginPasswordRedactions,
  resolveLoginFill,
  revealBotSecret,
  saveLoginPasskey,
  storeBotSecret,
  VaultItemRefusedError,
} from "../bot-secrets.js";
import { fakeDatabase } from "../bot-secrets.test-support.js";
import { EncryptedSecretStore } from "../secrets.js";
import {
  LOGIN_NEW_PASSKEY_FIELD,
  LOGIN_PASSKEY_FIELD,
  loginUseSummary,
  requestedLoginFills,
} from "./vault-card-use.js";
import { passkeySignCount } from "./vault-login-fill.js";
import { openVaultValue } from "./vault-values.js";

const owner = { userId: "user-1", spaceId: "space-1" };
const bot = { ...owner, botId: "bot-1" };
const secretStore = new EncryptedSecretStore("test-only-encryption-key");
const origin = "https://portal.example.test";
const login: BotSecretDestination = { name: "portal", origin, auth: { type: "login" } };
// base64 with every character base64url writes differently.
const PRIVATE_KEY = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49fake+passkey/private+key/AQ==";
const passkey: LoginPasskey = {
  rpId: "portal.example.test",
  credentialId: "fake-credential-id",
  privateKey: PRIVATE_KEY,
  userHandle: "fake-user-handle",
};
const value = (password = "fake-password-1") =>
  JSON.stringify({
    fields: [
      { label: "Email", value: "alex@example.test", hidden: false },
      { label: "Password", value: password, hidden: true },
    ],
  });

async function savedLogin() {
  const db = fakeDatabase();
  await storeBotSecret({
    prisma: db.prisma,
    secretStore,
    scope: owner,
    destination: login,
    plaintext: value(),
  });
  return db;
}

async function saved(db: ReturnType<typeof fakeDatabase>) {
  const row = await db.prisma.vaultCredential.findFirst({ where: { name: "portal" } });
  return decodeLoginSecret(await openVaultValue(db.prisma, secretStore, row!));
}

describe("a login's passkey", () => {
  it("is set by a bot beside the saved login, and only on the login it was made for", async () => {
    const db = await savedLogin();
    const row = await db.prisma.vaultCredential.findFirst({ where: { name: "portal" } });
    const set = (input: { name?: string; id?: string; origin?: string }) =>
      saveLoginPasskey({
        prisma: db.prisma,
        secretStore,
        scope: bot,
        name: input.name ?? "portal",
        passkey,
        ...(input.id ? { id: input.id } : {}),
        ...(input.origin ? { origin: input.origin } : {}),
      });
    expect(await set({ id: "another-login" })).toBe(false);
    expect(await set({ name: "missing" })).toBe(false);
    // Made on a site the login was moved off while the passkey was created.
    expect(await set({ id: row!.id, origin: "https://old.example.test" })).toBe(false);
    expect((await saved(db)).passkey).toBeUndefined();
    expect(await set({ id: row!.id, origin })).toBe(true);
    expect(await saved(db)).toMatchObject({
      passkey,
      fields: [{ value: "alex@example.test" }, { value: "fake-password-1" }],
    });
  });

  it("is never imported: an owner's save neither sets one nor drops the saved one", async () => {
    const db = await savedLogin();
    await expect(
      storeBotSecret({
        prisma: db.prisma,
        secretStore,
        scope: owner,
        destination: login,
        plaintext: "",
        passkey,
      }),
    ).rejects.toThrow(VaultItemRefusedError);
    await saveLoginPasskey({ prisma: db.prisma, secretStore, scope: bot, name: "portal", passkey });
    // A value sent with a passkey in it saves without it, and the saved one stays.
    const other = { ...passkey, privateKey: "fake-imported-key" };
    await storeBotSecret({
      prisma: db.prisma,
      secretStore,
      scope: owner,
      destination: login,
      plaintext: JSON.stringify({ ...JSON.parse(value("fake-password-2")), passkey: other }),
    });
    expect(await saved(db)).toMatchObject({ passkey, fields: [{}, { value: "fake-password-2" }] });
    // Nor does it set one on a new login, or on one that has none yet, from the owner or a bot.
    for (const scope of [owner, bot]) {
      const empty = fakeDatabase();
      for (const password of ["fake-password-1", "fake-password-2"])
        await storeBotSecret({
          prisma: empty.prisma,
          secretStore,
          scope,
          destination: login,
          plaintext: JSON.stringify({ ...JSON.parse(value(password)), passkey: other }),
        });
      expect((await saved(empty)).passkey).toBeUndefined();
    }
  });

  it("refuses an owner's save that the kept passkey would make too long, keeping the saved login", async () => {
    const db = await savedLogin();
    await saveLoginPasskey({ prisma: db.prisma, secretStore, scope: bot, name: "portal", passkey });
    // Ten characters short of the limit as sent, too long with the passkey it keeps.
    const field = (n: number, length: number) => ({
      label: `Field ${n}`,
      value: "x".repeat(length),
      hidden: true,
    });
    const fields = [field(1, 4096), field(2, 4096), field(3, 4096), field(4, 1)];
    fields[3]!.value += "x".repeat(
      BOT_SECRET_VALUE_MAX_LENGTH - 10 - JSON.stringify({ fields }).length,
    );
    expect(JSON.stringify({ fields }).length).toBe(BOT_SECRET_VALUE_MAX_LENGTH - 10);
    await expect(
      storeBotSecret({
        prisma: db.prisma,
        secretStore,
        scope: owner,
        destination: login,
        plaintext: JSON.stringify({ fields }),
      }),
    ).rejects.toThrow(new VaultItemRefusedError("This login is too long"));
    expect(await saved(db)).toMatchObject({ passkey, fields: [{}, { value: "fake-password-1" }] });
  });

  it("goes when the login moves to another site, or its owner removes it", async () => {
    for (const change of ["move", "remove"] as const) {
      const db = await savedLogin();
      await saveLoginPasskey({
        prisma: db.prisma,
        secretStore,
        scope: bot,
        name: "portal",
        passkey,
      });
      if (change === "move")
        await storeBotSecret({
          prisma: db.prisma,
          secretStore,
          scope: owner,
          destination: { ...login, origin: "https://other.example.test" },
          plaintext: value(),
          // A login card the person answered for its new site.
          replaces: String(db.rows()[0]!.id),
        });
      else
        expect(
          await saveLoginPasskey({
            prisma: db.prisma,
            secretStore,
            scope: owner,
            name: "portal",
            passkey: null,
          }),
        ).toBe(true);
      expect((await saved(db)).passkey).toBeUndefined();
      expect((await saved(db)).fields).toHaveLength(2);
    }
  });

  it("shows only its site, is never revealed, and is hidden in every run", async () => {
    const db = await savedLogin();
    await saveLoginPasskey({ prisma: db.prisma, secretStore, scope: bot, name: "portal", passkey });
    const [item] = await listVaultItems(db.prisma, secretStore, owner);
    expect(item?.preview).toMatchObject({ passkey: "portal.example.test" });
    const revealed = await revealBotSecret({
      prisma: db.prisma,
      secretStore,
      scope: owner,
      name: "portal",
    });
    expect(revealed).toMatchObject({ fields: [{}, { value: "fake-password-1" }] });
    expect(JSON.stringify(revealed)).not.toContain("passkey");
    expect(JSON.stringify([item, revealed])).not.toContain(PRIVATE_KEY);
    expect(JSON.stringify([item, revealed])).not.toContain(passkey.credentialId);
    const hidden = await loadLoginPasswordRedactions(db.prisma, secretStore, bot);
    expect(hidden).toEqual(
      expect.arrayContaining([
        PRIVATE_KEY,
        PRIVATE_KEY.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""),
      ]),
    );
  });

  it("leaves only the redaction marker in run output, split across streamed chunks too", async () => {
    const db = await savedLogin();
    await saveLoginPasskey({ prisma: db.prisma, secretStore, scope: bot, name: "portal", passkey });
    const hidden = await loadLoginPasswordRedactions(db.prisma, secretStore, bot);
    const url = PRIVATE_KEY.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    for (const form of [PRIVATE_KEY, url, encodeURIComponent(PRIVATE_KEY)]) {
      const whole = redactSecrets(`key: ${form} end`, hidden);
      expect(whole).toBe(`key: ${REDACTED_MARKER} end`);
      // A stream that sends the key in two chunks hides the second half as well.
      const half = Math.floor(form.length / 2);
      const split = redactSecretsAfter(
        `key: ${form.slice(0, half)}`,
        `${form.slice(half)} end`,
        hidden,
      );
      expect(split).not.toContain(form.slice(half));
      expect(split).toContain(REDACTED_MARKER);
    }
    // The list a bot reads, which is all a search sees, names only the site.
    const [item] = await listVaultItems(db.prisma, secretStore, bot);
    expect(JSON.stringify(item)).not.toContain(PRIVATE_KEY.slice(0, 24));
    expect(JSON.stringify(item)).not.toContain(url.slice(-24));
    // Exact spellings only, as for a password: the key never reaches the page, which holds only the
    // browser's authenticator, so nothing writes it with a zero-width or other invisible character.
  });

  it("is handed out for a sign-in only, and creating one always asks first", async () => {
    const db = await savedLogin();
    const fill = (passkeyMode: "use" | "create", fields?: string[]) =>
      resolveLoginFill({
        prisma: db.prisma,
        secretStore,
        scope: bot,
        runId: "run-1",
        name: "portal",
        field: "",
        passkey: passkeyMode,
        ...(fields && {
          approval: {
            kind: "login" as const,
            login: "portal",
            site: origin,
            title: "Portal",
            fields,
            savedAt: (db.rows()[0]!.updatedAt as Date).toISOString(),
          },
        }),
      });
    expect(await fill("use")).toEqual({ error: expect.stringContaining("no passkey") });
    expect(await fill("create")).toEqual({ error: expect.stringContaining("not approved") });
    // An approval to sign in with the passkey is no approval to create one.
    expect(await fill("create", [LOGIN_PASSKEY_FIELD])).toEqual({
      error: expect.stringContaining("not approved"),
    });
    expect(await fill("create", [LOGIN_NEW_PASSKEY_FIELD])).toMatchObject({
      origin,
      text: "",
      used: { name: "portal" },
    });
    await saveLoginPasskey({ prisma: db.prisma, secretStore, scope: bot, name: "portal", passkey });
    // An allowed login signs in without asking, with the key hidden from the run.
    const used = await fill("use");
    expect(used).toMatchObject({ origin, passkey, text: "" });
    expect("redactions" in used && used.redactions).toContain(PRIVATE_KEY);
  });

  it("is refused for a login this run was only given, which has nowhere to keep one", async () => {
    const db = fakeDatabase();
    const result = await resolveLoginFill({
      prisma: db.prisma,
      secretStore,
      scope: bot,
      runId: "run-1",
      name: "portal",
      field: "",
      passkey: "use",
    });
    expect(result).toHaveProperty("error");
  });

  it("signs in with a counter that rises with the server's clock", () => {
    const now = Date.parse("2026-11-20T00:00:00Z");
    expect(passkeySignCount(now)).toBeGreaterThan(0);
    expect(passkeySignCount(now + 1000)).toBe(passkeySignCount(now) + 1);
    expect(passkeySignCount(0)).toBe(0);
  });

  it("asks on a card naming what creating one does", () => {
    const steps = [
      { kind: "create_passkey", ref: "e1", secret: "portal" },
      { kind: "use_passkey", ref: "e2", secret: "bank" },
      { kind: "use_passkey", ref: "e2" },
    ];
    expect(requestedLoginFills(steps)).toEqual(
      new Map([
        ["portal", [LOGIN_NEW_PASSKEY_FIELD]],
        ["bank", [LOGIN_PASSKEY_FIELD]],
      ]),
    );
    const use = {
      kind: "login" as const,
      login: "portal",
      site: origin,
      title: "Portal",
      savedAt: "",
    };
    expect(loginUseSummary({ ...use, fields: [LOGIN_NEW_PASSKEY_FIELD] })).toMatchObject({
      onceOnly: true,
      title: "Create a passkey on portal.example.test for Portal?",
    });
    expect(loginUseSummary({ ...use, fields: [LOGIN_PASSKEY_FIELD] }).lines).toEqual([
      "This uses the login's passkey.",
    ]);
  });
});
