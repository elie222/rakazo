import { describe, expect, it } from "vitest";
import {
  BotSecretDestination,
  CardSecretValue,
  ContactSecretValue,
  cardBrand,
  cardExpiry,
  cardSummary,
  cardTitle,
  parseCardExpiry,
  VaultPutInput,
} from "./bot-secrets.js";

describe("cards", () => {
  it("keeps a typed number as digits and refuses one that fails the Luhn check", () => {
    const card = CardSecretValue.parse({
      number: "4242 4242-4242 4242",
      expMonth: 8,
      expYear: 2030,
      cvc: "",
      name: "  ",
    });
    expect(card).toEqual({ number: "4242424242424242", expMonth: 8, expYear: 2030 });
    expect(
      CardSecretValue.safeParse({ number: "4242424242424241", expMonth: 8, expYear: 2030 }).success,
    ).toBe(false);
  });

  it("names the network, the last four digits and the expiry, never the number", () => {
    const card = CardSecretValue.parse({
      number: "5555555555554444",
      expMonth: 3,
      expYear: 2031,
      cvc: "123",
    });
    const summary = cardSummary(card);
    expect(summary).toEqual({ brand: "Mastercard", last4: "4444", expMonth: 3, expYear: 2031 });
    expect(cardTitle(summary)).toBe("Mastercard ·· 4444");
    expect(cardExpiry(summary)).toBe("03/31");
    expect(cardBrand("378282246310005")).toBe("Amex");
    expect(cardBrand("9999")).toBe("Card");
  });

  it("reads an expiry as people type it", () => {
    expect(parseCardExpiry("08/28")).toEqual({ expMonth: 8, expYear: 2028 });
    expect(parseCardExpiry("8 / 2029")).toEqual({ expMonth: 8, expYear: 2029 });
    expect(parseCardExpiry("0828")).toEqual({ expMonth: 8, expYear: 2028 });
    expect(parseCardExpiry("13/28")).toBeUndefined();
  });
});

describe("contacts", () => {
  it("drops empty fields and needs at least one", () => {
    expect(ContactSecretValue.parse({ name: "Alex Rivera", line2: "" })).toEqual({
      name: "Alex Rivera",
    });
    expect(ContactSecretValue.safeParse({ city: " " }).success).toBe(false);
    expect(ContactSecretValue.safeParse({ name: "A", password: "x" }).success).toBe(false);
  });
});

describe("vault destinations", () => {
  it("saves cards and contacts without a site", () => {
    for (const type of ["card", "contact"] as const) {
      expect(BotSecretDestination.safeParse({ name: "home", auth: { type } }).success).toBe(true);
      expect(
        BotSecretDestination.safeParse({
          name: "home",
          origin: "https://www.example.com",
          auth: { type },
        }).success,
      ).toBe(false);
    }
  });

  it("lets a new item leave out its name, and a saved one its value", () => {
    expect(
      VaultPutInput.safeParse({ destination: { auth: { type: "contact" } }, value: "{}" }).success,
    ).toBe(true);
    expect(
      VaultPutInput.safeParse({
        destination: { name: "home", auth: { type: "contact" } },
        title: "Home",
      }).success,
    ).toBe(true);
    expect(
      VaultPutInput.safeParse({ destination: { auth: { type: "login" } }, value: "{}" }).success,
    ).toBe(false);
  });
});
