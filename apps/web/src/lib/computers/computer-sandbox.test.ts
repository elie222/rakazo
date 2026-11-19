import { describe, expect, it } from "vitest";
import {
  canChooseOwnComputer,
  computersAreUnavailable,
  runsOnUserMachine,
  sandboxCheckFailureMessage,
} from "./computer-sandbox.js";

describe("runsOnUserMachine", () => {
  it("takes the server's word, and reads the kind only when an older server gives none", () => {
    expect(runsOnUserMachine({ kind: "any-kind", runsOnUserMachine: true })).toBe(true);
    expect(runsOnUserMachine({ kind: "desktop", runsOnUserMachine: false })).toBe(false);
    expect(runsOnUserMachine({ kind: "desktop" })).toBe(true);
    expect(runsOnUserMachine({ kind: "any-kind" })).toBe(false);
    expect(runsOnUserMachine(null)).toBe(false);
  });
});

describe("computersAreUnavailable", () => {
  it("treats none and empty as unavailable", () => {
    expect(computersAreUnavailable("none")).toBe(true);
    expect(computersAreUnavailable("")).toBe(true);
    expect(computersAreUnavailable(null)).toBe(false);
  });

  it("treats configured providers as available", () => {
    expect(computersAreUnavailable("docker")).toBe(false);
    expect(computersAreUnavailable("e2b")).toBe(false);
  });
});

describe("canChooseOwnComputer", () => {
  it("offers an account its own desktop wherever Settings routes computers", () => {
    expect(canChooseOwnComputer("docker")).toBe(true);
    expect(canChooseOwnComputer("test-desktop")).toBe(true);
    expect(canChooseOwnComputer("none")).toBe(false);
    expect(canChooseOwnComputer("desktop")).toBe(false);
    expect(canChooseOwnComputer("fake")).toBe(false);
    expect(canChooseOwnComputer(null)).toBe(false);
  });
});

describe("sandboxCheckFailureMessage", () => {
  it("returns error message or fallback", () => {
    expect(sandboxCheckFailureMessage(new Error("offline"))).toBe("offline");
    expect(sandboxCheckFailureMessage(null)).toBe("Could not reach the server");
  });
});
