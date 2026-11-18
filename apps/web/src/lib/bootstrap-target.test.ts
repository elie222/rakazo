import type { AppBootstrap } from "@rakazo/contracts";
import { describe, expect, it } from "vitest";
import { initialBootstrapTarget, linkedBotRoute, linkedGroupRoute } from "./bootstrap-target";

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
    expect(initialBootstrapTarget("/app/g/group-1?m=message-1", false)).toStrictEqual({
      botId: undefined,
      groupId: "group-1",
    });
    expect(initialBootstrapTarget("/app/g", false)).toStrictEqual({
      botId: undefined,
      groupId: undefined,
    });
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

  it("opens the Space the server says holds the linked bot, keeping the link's query", () => {
    expect(linkedBotRoute(loaded("work"), "scout", "?m=message-1&routine=r1")).toEqual({
      spaceId: "work",
      path: "/app/scout?m=message-1&routine=r1",
    });
    expect(initialBootstrapTarget("/app/scout?m=message-1", false)).toEqual({ botId: "scout" });
  });

  it("stays put for a bot already here, no link, or no other Space", () => {
    expect(linkedBotRoute(loaded("work"), "chief", "")).toBeUndefined();
    expect(linkedBotRoute(loaded("work"), undefined, "")).toBeUndefined();
    expect(linkedBotRoute(loaded(), "scout", "")).toBeUndefined();
    expect(linkedBotRoute(loaded("home"), "scout", "")).toBeUndefined();
  });
});

describe("linked group in another Space", () => {
  const loaded = (groupSpaceId?: string) => ({
    me: { spaceId: "home" } as AppBootstrap["me"],
    groups: [{ id: "standup" }] as AppBootstrap["groups"],
    groupSpaceId,
  });

  it("opens the Space the server says holds the linked group, keeping the link's query", () => {
    expect(linkedGroupRoute(loaded("work"), "retro", "?m=message-1")).toEqual({
      spaceId: "work",
      path: "/app/g/retro?m=message-1",
    });
  });

  it("stays put for a group already here, no link, or no other Space", () => {
    expect(linkedGroupRoute(loaded("work"), "standup", "")).toBeUndefined();
    expect(linkedGroupRoute(loaded("work"), undefined, "")).toBeUndefined();
    expect(linkedGroupRoute(loaded(), "retro", "")).toBeUndefined();
    expect(linkedGroupRoute(loaded("home"), "retro", "")).toBeUndefined();
  });
});
