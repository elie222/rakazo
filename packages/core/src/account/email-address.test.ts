import { describe, expect, it } from "vitest";
import { canonicalEmail, emailSpellings } from "./email-address.js";

describe("canonicalEmail", () => {
  it("stores Gmail's alternate domain as gmail.com", () => {
    expect(canonicalEmail("Person@GoogleMail.com")).toBe("person@gmail.com");
    expect(canonicalEmail(" person@gmail.com ")).toBe("person@gmail.com");
  });

  it("leaves other domains and look-alikes alone", () => {
    expect(canonicalEmail("person@googlemail.com.example.test")).toBe(
      "person@googlemail.com.example.test",
    );
    expect(canonicalEmail("Person@Example.com")).toBe("person@example.com");
    expect(canonicalEmail("no-at-sign")).toBe("no-at-sign");
  });
});

describe("emailSpellings", () => {
  it("lists the canonical address first, then the alternate domains of the same mailbox", () => {
    expect(emailSpellings("Person@GoogleMail.com")).toEqual([
      "person@gmail.com",
      "person@googlemail.com",
    ]);
    expect(emailSpellings("person@example.com")).toEqual(["person@example.com"]);
  });
});
