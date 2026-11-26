import { describe, expect, it } from "vitest";
import { normalizePhoneNumber } from "./phone-network.js";

describe("normalizePhoneNumber", () => {
  it("keeps an already valid E.164 number", () => {
    expect(normalizePhoneNumber("+14155550123")).toBe("+14155550123");
  });

  it("drops the formatting a person would type", () => {
    expect(normalizePhoneNumber("+1 (415) 555-0123")).toBe("+14155550123");
    expect(normalizePhoneNumber("+1-415-555-0123")).toBe("+14155550123");
    expect(normalizePhoneNumber("+1.415.555.0123")).toBe("+14155550123");
    expect(normalizePhoneNumber("  +14155550123  ")).toBe("+14155550123");
  });

  it("accepts the shortest and the longest E.164 lengths", () => {
    expect(normalizePhoneNumber("+1234567")).toBe("+1234567");
    expect(normalizePhoneNumber("+123456789012345")).toBe("+123456789012345");
  });

  it("rejects a number that is too short", () => {
    expect(normalizePhoneNumber("+123456")).toBeNull();
  });

  it("rejects a number that is too long", () => {
    expect(normalizePhoneNumber("+1234567890123456")).toBeNull();
  });

  it("rejects a number without the international marker", () => {
    expect(normalizePhoneNumber("14155550123")).toBeNull();
  });

  it("rejects a number that carries letters", () => {
    expect(normalizePhoneNumber("+1415555CALL")).toBeNull();
  });

  it("rejects an empty number", () => {
    expect(normalizePhoneNumber("")).toBeNull();
  });

  it("rejects a lone marker", () => {
    expect(normalizePhoneNumber("+")).toBeNull();
  });
});
