import type { BotSecretMetadata, ContactFields } from "@rakazo/contracts";
import {
  decodeCardSecret,
  decodeContactSecret,
  decodeLoginSecret,
  vaultKind,
} from "@rakazo/contracts";
import { describe, expect, it } from "vitest";

import type { VaultDraft, VaultItem } from "./vault";
import {
  billingChoices,
  draftSave,
  emptyDraft,
  filterVaultItems,
  itemDraft,
  readableItem,
  typedCardBrand,
  variableProblem,
  vaultItemSubtitle,
  vaultKindsPresent,
  withItem,
} from "./vault";

const item = (change: Partial<BotSecretMetadata>): BotSecretMetadata => ({
  name: "github",
  origin: "https://api.github.com",
  auth: { type: "bearer" },
  title: "api.github.com",
  note: "",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  ...change,
});
const card = item({
  name: "visa",
  origin: "",
  auth: { type: "card" },
  title: "Visa ·· 4242",
  note: "For travel",
  preview: { card: { brand: "Visa", last4: "4242", expMonth: 8, expYear: 2028, billing: "home" } },
});
const home = item({
  name: "home",
  origin: "",
  auth: { type: "contact" },
  title: "Home",
  preview: {
    contact: { name: "Alex Rivera", line1: "12 Elm St", city: "Springfield" } as ContactFields,
  },
});
const login = item({
  name: "github-login",
  origin: "https://www.github.com",
  auth: { type: "login" },
  title: "github.com",
  preview: { username: "octo@example.com" },
});
const variable = item({ name: "deploy_token", origin: "", auth: { type: "command" } });
const draft = (change: Partial<VaultDraft>): VaultDraft => ({ ...emptyDraft(), ...change });

describe("vault list", () => {
  it("files every auth type under the kind people add and filter by", () => {
    expect(vaultKind("bearer")).toBe("api_key");
    expect(vaultKind("header")).toBe("api_key");
    expect(vaultKind("command")).toBe("variable");
    expect(vaultKind("card")).toBe("card");
  });

  it("shows the same subtitles as the web vault", () => {
    expect(vaultItemSubtitle(login)).toBe("octo@example.com");
    expect(vaultItemSubtitle(card)).toBe("Expires 08/28 · For travel");
    expect(vaultItemSubtitle(home)).toBe("Alex Rivera · 12 Elm St, Springfield");
    expect(vaultItemSubtitle(item({}))).toBe("API key");
    expect(vaultItemSubtitle(item({ title: "GitHub" }))).toBe("API key · api.github.com");
    expect(vaultItemSubtitle(variable)).toBe("$DEPLOY_TOKEN");
    expect(vaultItemSubtitle(item({ auth: null }))).toBe("https://api.github.com");
  });

  it("filters by kind and searches titles and subtitles", () => {
    const all = [login, card, home, variable];
    expect(vaultKindsPresent(all)).toEqual(["login", "card", "contact", "variable"]);
    expect(filterVaultItems(all, "card", "")).toEqual([card]);
    expect(filterVaultItems(all, "all", "springfield")).toEqual([home]);
    expect(filterVaultItems(all, "all", "  ")).toEqual(all);
  });

  it("offers contacts to bill a card to, and replaces a saved item by name", () => {
    expect(billingChoices([login, card, home])).toEqual([{ key: "home", label: "Home" }]);
    const renamed = { ...home, title: "Our place" };
    expect(withItem([login, home], renamed)).toEqual([login, renamed]);
    expect(withItem([login], home)).toEqual([login, home]);
  });

  it("only edits items whose settings still read", () => {
    expect(readableItem(item({ auth: null }))).toBeNull();
    expect(readableItem(item({ name: "Legacy Name" }))).toBeNull();
    expect(readableItem(card)).toEqual(card);
  });
});

describe("saving from the editor", () => {
  it("saves a new card under a name the server picks, as its encoded value", () => {
    const save = draftSave(
      "card",
      draft({ number: "4242 4242 4242 4242", expiry: "8/28", cvc: "123", title: " Work " }),
    );
    expect(save?.destination).toEqual({ auth: { type: "card" } });
    expect(save?.title).toBe("Work");
    expect(decodeCardSecret(save!.value!)).toEqual({
      number: "4242424242424242",
      expMonth: 8,
      expYear: 2028,
      cvc: "123",
    });
    expect(
      draftSave("card", draft({ number: "4242 4242 4242 4241", expiry: "8/28" })),
    ).toBeUndefined();
    expect(typedCardBrand("42")).toBe("Visa");
    expect(typedCardBrand("1")).toBeUndefined();
  });

  it("saves a contact's fields, and needs at least one", () => {
    const save = draftSave(
      "contact",
      draft({ contact: { ...emptyDraft().contact, city: "Paris", phone: " " } }),
    );
    expect(decodeContactSecret(save!.value!)).toEqual({ city: "Paris" });
    expect(draftSave("contact", draft({}))).toBeUndefined();
  });

  it("saves a new login, API key or variable only once it has what it needs", () => {
    const fields = [
      { label: "Username", value: "ada", hidden: false },
      { label: "Password", value: "example-password", hidden: true },
    ];
    expect(draftSave("login", draft({ fields }))).toBeUndefined();
    const save = draftSave("login", draft({ fields, origin: "https://example.test" }));
    expect(save?.destination).toEqual({ origin: "https://example.test", auth: { type: "login" } });
    expect(decodeLoginSecret(save!.value!).fields).toEqual(fields);

    expect(
      draftSave("api_key", draft({ origin: "https://api.example.test", value: "k" })),
    ).toMatchObject({
      destination: { origin: "https://api.example.test", auth: { type: "bearer" } },
      value: "k",
    });
    expect(
      draftSave("api_key", draft({ origin: "https://x.test", apiAuth: "header", value: "k" })),
    ).toBeUndefined();

    expect(draftSave("variable", draft({ variable: "DEPLOY_TOKEN", value: "v" }))).toMatchObject({
      destination: { name: "deploy_token", auth: { type: "command" } },
    });
    expect(variableProblem(draft({ variable: "PATH" }))).toBe("reserved");
    expect(variableProblem(draft({ variable: "1X" }))).toBe("invalid");
    expect(draftSave("variable", draft({ variable: "PATH", value: "v" }))).toBeUndefined();
  });

  it("edits a saved card from its revealed value, so every field is sent", () => {
    const saved = readableItem(card) as VaultItem;
    const revealed = {
      card: { number: "4242424242424242", expMonth: 8, expYear: 2028, cvc: "123", billing: "home" },
    };
    const start = itemDraft(saved, [], revealed);
    expect(start).toMatchObject({ number: "4242424242424242", expiry: "08/28", cvc: "123" });
    const save = draftSave("card", { ...start, expiry: "09/29", title: "Work" }, saved);
    expect(save).toMatchObject({ destination: { name: "visa" }, title: "Work" });
    expect(decodeCardSecret(save!.value!)).toMatchObject({
      expMonth: 9,
      expYear: 2029,
      cvc: "123",
    });
  });

  it("edits a saved login from all of its revealed fields", () => {
    const saved = readableItem(login) as VaultItem;
    const fields = [
      { label: "Email", value: "octo@example.com", hidden: false },
      { label: "Password", value: "fake-password-1", hidden: true },
      { label: "PIN", value: "fake-pin-1", hidden: true },
    ];
    const start = itemDraft(saved, [], { fields });
    const changed = start.fields.map((field, index) =>
      index === 0 ? { ...field, value: "new@example.com" } : field,
    );
    const save = draftSave("login", { ...start, fields: changed }, saved);
    expect(decodeLoginSecret(save!.value!).fields).toEqual([
      { label: "Email", value: "new@example.com", hidden: false },
      { label: "Password", value: "fake-password-1", hidden: true },
      { label: "PIN", value: "fake-pin-1", hidden: true },
    ]);
  });

  it("keeps a key's value, which the form never shows, until a new one is typed", () => {
    const key = readableItem(item({})) as VaultItem;
    // The title shown is read from the item; leaving it as it was keeps it that way.
    expect(draftSave("api_key", itemDraft(key, []), key)).toEqual({
      destination: { name: "github", origin: "https://api.github.com", auth: { type: "bearer" } },
      note: "",
    });
    expect(draftSave("api_key", { ...itemDraft(key, []), title: "GitHub" }, key)?.title).toBe(
      "GitHub",
    );
    expect(draftSave("api_key", { ...itemDraft(key, []), value: "new" }, key)?.value).toBe("new");
  });

  it("always sends a contact's fields, which are not secret", () => {
    const saved = readableItem(home) as VaultItem;
    const save = draftSave("contact", itemDraft(saved, []), saved);
    expect(save?.destination).toEqual({ name: "home", auth: { type: "contact" } });
    expect(decodeContactSecret(save!.value!)).toEqual(home.preview!.contact);
  });
});
