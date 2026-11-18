import { describe, expect, it } from "vitest";
import { canonicalEmail } from "./email-address.js";

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
