import { describe, expect, it } from "vitest";
import { initialBootstrapTarget } from "./bootstrap-target";

describe("initial bootstrap target", () => {
  it("primes the Electron root before its client-side redirect", () => {
    expect(initialBootstrapTarget("/", true)).toEqual({ botId: undefined });
    expect(initialBootstrapTarget("/", false)).toBeNull();
  });

  it("primes browser app routes and decodes their selected bot", () => {
    expect(initialBootstrapTarget("/app", false)).toEqual({ botId: undefined });
    expect(initialBootstrapTarget("/app/research%20bot", false)).toEqual({
      botId: "research bot",
    });
    expect(initialBootstrapTarget("/app/g/group-1", false)).toEqual({ botId: undefined });
  });

  it("does not prime unrelated routes", () => {
    expect(initialBootstrapTarget("/sign-in", true)).toBeNull();
    expect(initialBootstrapTarget("/onboarding", false)).toBeNull();
  });
});
