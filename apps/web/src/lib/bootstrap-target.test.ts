import type { AppBootstrap } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { initialBootstrapTarget, linkedBotSpaceId } from "./bootstrap-target";

describe("initial bootstrap target", () => {
  it("primes the Electron root before its client-side redirect", () => {
    expect(initialBootstrapTarget("/", true)).toEqual({ botId: undefined });
    expect(initialBootstrapTarget("/", false)).toBeNull();
  });

  it("primes browser app routes and decodes their selected bot", () => {
    expect(initialBootstrapTarget("/app/board", false)).toEqual({ botId: undefined });
    expect(initialBootstrapTarget("/app/x/clients", false)).toEqual({ botId: undefined });
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

describe("linked bot in another Space", () => {
  const loaded = (botSpaceId?: string) => ({
    me: { spaceId: "home" } as AppBootstrap["me"],
    bots: [{ id: "chief" }] as AppBootstrap["bots"],
    botSpaceId,
  });

  it("opens the Space the server says holds the linked bot", () => {
    expect(linkedBotSpaceId(loaded("work"), "scout")).toBe("work");
  });

  it("stays put for a bot already here, no link, or no other Space", () => {
    expect(linkedBotSpaceId(loaded("work"), "chief")).toBeUndefined();
    expect(linkedBotSpaceId(loaded("work"), undefined)).toBeUndefined();
    expect(linkedBotSpaceId(loaded(), "scout")).toBeUndefined();
    expect(linkedBotSpaceId(loaded("home"), "scout")).toBeUndefined();
  });
});
