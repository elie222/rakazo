import type { BotSecretDestination } from "@rakazo/contracts";
import { encodeCardSecret, encodeContactSecret } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import {
  defaultVaultItemTitle,
  listBotSecrets,
  listVaultItems,
  loadLoginPasswordRedactions,
  newVaultItemName,
  relabelVaultItem,
  resolveLoginFill,
  resolveVaultCardFill,
  revealBotSecret,
  storeBotSecret,
} from "./bot-secrets.js";
import { fakeDatabase } from "./bot-secrets.test-support.js";
import { EncryptedSecretStore } from "./secrets.js";
import { cardUseSummary, requestedCardUse, vaultCardUseOf } from "./vault-card-use.js";

const scope = { userId: "user-1", spaceId: "space-1" };
const secretStore = new EncryptedSecretStore("test-only-encryption-key");
const card = { type: "card" } as const;
const contact = { type: "contact" } as const;
const fakeCard = {
  number: "4242 4242 4242 4242",
  expMonth: 8,
  expYear: 2030,
  cvc: "123",
  name: "Alex Rivera",
  billing: "home",
};
const fakeHome = {
  name: "Alex Rivera",
  line1: "12 Elm St",
  city: "Springfield",
  postalCode: "12345",
  phone: "+1 555 0100",
};

function save(
  db: ReturnType<typeof fakeDatabase>,
  name: string,
  plaintext: string,
  auth: BotSecretDestination["auth"],
  labels: { title?: string; note?: string } = {},
) {
  return storeBotSecret({
    prisma: db.prisma,
    secretStore,
    scope,
    destination: { name, origin: "", auth },
    plaintext,
    ...labels,
  });
}

async function vaultWithCard() {
  const db = fakeDatabase();
  await save(db, "home", JSON.stringify(fakeHome), contact, { title: "Home" });
  await save(db, "visa", JSON.stringify(fakeCard), card, { note: "For travel" });
  return db;
}

describe("saving cards and contacts", () => {
  it("encrypts the whole value and saves it in its canonical shape", async () => {
    const db = await vaultWithCard();
    const row = db.rows().find((stored) => stored.name === "visa")!;
    // Random base64 can hold a short substring by chance, so look for whole plaintext
    // pieces it cannot produce: the full card number (as saved and as typed), and a street
    // line with spaces.
    expect(row.ciphertext).not.toContain("4242424242424242");
    expect(row.ciphertext).not.toContain(fakeCard.number);
    expect(JSON.parse(await secretStore.load(row.ciphertext, row.id))).toMatchObject({
      number: "4242424242424242",
    });
    const home = db.rows().find((stored) => stored.name === "home")!;
    expect(home.ciphertext).not.toContain("12 Elm St");
  });

  it("refuses a value that is not a card or contact without quoting it", async () => {
    const db = fakeDatabase();
    await expect(
      save(db, "visa", JSON.stringify({ ...fakeCard, number: "4242424242424241" }), card),
    ).rejects.toThrow(/^Invalid card$/);
    await expect(save(db, "home", "12 Elm St", contact)).rejects.toThrow(/^Invalid contact$/);
  });
});

describe("the owner's list", () => {
  it("shows titles and previews, never a card's number or security code", async () => {
    const db = await vaultWithCard();
    const items = await listVaultItems(db.prisma, secretStore, scope);
    expect(items.map(({ name, title, note, preview }) => ({ name, title, note, preview }))).toEqual(
      [
        { name: "home", title: "Home", note: undefined, preview: { contact: fakeHome } },
        {
          name: "visa",
          title: "Visa ·· 4242",
          note: "For travel",
          preview: {
            card: {
              brand: "Visa",
              last4: "4242",
              expMonth: 8,
              expYear: 2030,
              name: "Alex Rivera",
              billing: "home",
            },
          },
        },
      ],
    );
    expect(JSON.stringify(items)).not.toContain("4242424242424242");
    expect(JSON.stringify(items)).not.toContain('"123"');
  });

  it("shows a login's first visible field under its site", async () => {
    const db = fakeDatabase();
    await storeBotSecret({
      prisma: db.prisma,
      secretStore,
      scope,
      destination: { name: "github", origin: "https://www.github.com", auth: { type: "login" } },
      plaintext: JSON.stringify({
        fields: [
          { label: "Email", value: "octo@example.com", hidden: false },
          { label: "Password", value: "fake-password-1", hidden: true },
        ],
      }),
    });
    const [item] = await listVaultItems(db.prisma, secretStore, scope);
    expect(item).toMatchObject({ title: "github.com", preview: { username: "octo@example.com" } });
    expect(JSON.stringify(item)).not.toContain("fake-password-1");
  });

  it("reveals a card to its owner in full", async () => {
    const db = await vaultWithCard();
    expect(await revealBotSecret({ prisma: db.prisma, secretStore, scope, name: "visa" })).toEqual({
      card: { ...fakeCard, number: "4242424242424242" },
    });
  });

  it("names a new item after its title or value, and changes only its labels", async () => {
    const db = await vaultWithCard();
    expect(await newVaultItemName(db.prisma, scope, "Home", "contact")).toBe("home-2");
    expect(await newVaultItemName(db.prisma, scope, "Café de Flore", "contact")).toBe(
      "cafe-de-flore",
    );
    expect(await newVaultItemName(db.prisma, scope, "בית", "contact")).toBe("contact");
    expect(defaultVaultItemTitle({ origin: "", auth: card }, encodeCardSecret(fakeCard))).toBe(
      "Visa ·· 4242",
    );
    expect(
      defaultVaultItemTitle({ origin: "", auth: contact }, encodeContactSecret({ city: "Paris" })),
    ).toBe("");
    expect(await relabelVaultItem(db.prisma, scope, "visa", { title: "Work card" })).toBe(true);
    const [, visa] = await listVaultItems(db.prisma, secretStore, scope);
    expect(visa).toMatchObject({ title: "Work card", note: "For travel" });
  });
});

describe("what the bot sees", () => {
  it("lists a contact in full and a card only by its summary", async () => {
    const db = await vaultWithCard();
    const listed = await listBotSecrets(db.prisma, secretStore, scope);
    expect(listed).toEqual([
      { name: "home", origin: "", auth: contact, title: "Home", contact: fakeHome },
      {
        name: "visa",
        origin: "",
        auth: card,
        note: "For travel",
        card: expect.objectContaining({ brand: "Visa", last4: "4242", expiry: "08/30" }),
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain("4242424242424242");
    expect(JSON.stringify(listed)).not.toContain('"123"');
  });

  it("hides every saved card number in every run", async () => {
    const db = await vaultWithCard();
    const forms = await loadLoginPasswordRedactions(db.prisma, secretStore, scope);
    expect(forms).toEqual(
      expect.arrayContaining(["4242424242424242", "4242 4242 4242 4242", "4242-4242-4242-4242"]),
    );
  });

  it("never fills a card or contact as a login", async () => {
    const db = await vaultWithCard();
    const fill = (name: string) =>
      resolveLoginFill({ prisma: db.prisma, secretStore, scope, runId: "run-1", name, field: "x" });
    expect(await fill("visa")).toEqual({ error: expect.stringContaining("fill_card") });
    expect(await fill("home")).toEqual({ error: expect.stringContaining("list_secrets") });
  });
});

describe("filling a saved card", () => {
  const savedAt = (db: ReturnType<typeof fakeDatabase>, name = "visa") =>
    db
      .rows()
      .find((row) => row.name === name)!
      .updatedAt!.toISOString();
  const fill = (
    db: ReturnType<typeof fakeDatabase>,
    field: string,
    site = "https://shop.example.test",
  ) =>
    resolveVaultCardFill({
      prisma: db.prisma,
      secretStore,
      scope,
      name: "visa",
      field: field as "number",
      site,
      savedAt: savedAt(db),
    });

  it("types each field only on the approved checkout's origin", async () => {
    const db = await vaultWithCard();
    expect(await fill(db, "number")).toEqual({
      text: "4242424242424242",
      origin: "https://shop.example.test",
      redactions: expect.arrayContaining(["4242424242424242"]),
    });
    expect(await fill(db, "expiry")).toMatchObject({ text: "08/30" });
    const cvc = await fill(db, "cvc");
    expect(cvc).toMatchObject({ text: "123" });
    // Hiding 3 digits would blank every total and order number that contains them.
    expect("redactions" in cvc && cvc.redactions).not.toContain("123");
    // The billing contact's postal code.
    expect(await fill(db, "postal_code")).toMatchObject({ text: "12345" });
  });

  it("refuses a site that is not an HTTPS origin, or a name that is not a card", async () => {
    const db = await vaultWithCard();
    expect(await fill(db, "number", "http://shop.example.test")).toEqual({
      error: expect.stringContaining("HTTPS"),
    });
    expect(
      await resolveVaultCardFill({
        prisma: db.prisma,
        secretStore,
        scope,
        name: "home",
        field: "number",
        site: "https://shop.example.test",
        savedAt: savedAt(db, "home"),
      }),
    ).toEqual({ error: expect.stringContaining("No card") });
  });

  it("refuses a card replaced after the user approved it", async () => {
    const db = await vaultWithCard();
    const approved = savedAt(db);
    await save(db, "visa", JSON.stringify({ ...fakeCard, number: "5555555555554444" }), card);
    expect(
      await resolveVaultCardFill({
        prisma: db.prisma,
        secretStore,
        scope,
        name: "visa",
        field: "number",
        site: "https://shop.example.test",
        savedAt: approved,
      }),
    ).toEqual({ error: expect.stringContaining("changed after the user approved") });
  });
});

describe("approving a saved card", () => {
  it("reads one card on one site from a browser_act call", () => {
    const step = { kind: "fill_card", card: "visa", site: "https://shop.example.test/checkout" };
    expect(
      requestedCardUse([
        { ...step, field: "number" },
        { ...step, field: "cvc" },
        { kind: "click", ref: "e1" },
      ]),
    ).toEqual({ card: "visa", site: "https://shop.example.test" });
    expect(requestedCardUse([{ kind: "fill_card", purchase: "p1" }])).toBeUndefined();
    expect(requestedCardUse([{ kind: "fill_card", purchase: "p1", card: "" }])).toBeUndefined();
    expect(requestedCardUse([{ kind: "fill_card", purchase: "p1", card: null }])).toBeUndefined();
    expect(
      requestedCardUse([
        { ...step, field: "number" },
        { ...step, site: "https://other.example.test", field: "cvc" },
      ]),
    ).toEqual({ error: expect.stringContaining("one site") });
    expect(requestedCardUse([{ kind: "fill_card", card: "visa", site: "" }])).toEqual({
      error: expect.stringContaining("HTTPS origin"),
    });
  });

  it("asks once, naming the card and the site, and keeps only a well-formed approval", () => {
    const use = {
      card: "visa",
      site: "https://shop.example.test",
      title: "Visa ·· 4242",
      savedAt: "2026-09-01T00:00:01.000Z",
    };
    expect(cardUseSummary(use)).toEqual({
      onceOnly: true,
      title: "Pay with Visa ·· 4242 on shop.example.test?",
      lines: [],
    });
    // Typed together with the click that pays: the card names what the page lists for the order.
    const purchase = {
      steps: [0],
      site: "shop.example.test",
      label: "Place order",
      amount: "$9.00",
      amountSource: "page" as const,
      items: [{ name: "Bananas × 6", amount: "$3.00" }],
    };
    expect(cardUseSummary(use, purchase).lines).toEqual([
      'Button: "Place order"',
      "Bananas × 6: $3.00",
      "Total on the page: $9.00",
      "The button label, items and total are read from the page. The bot has not checked them.",
    ]);
    expect(vaultCardUseOf(use)).toEqual(use);
    expect(vaultCardUseOf({ ...use, site: "http://shop.example.test" })).toBeUndefined();
    expect(vaultCardUseOf({ ...use, card: "Visa Card" })).toBeUndefined();
  });
});
