import { describe, expect, it } from "vitest";
import { ComputerStatusSchema } from "../computers/computer.js";
import { SandboxKind } from "../ids.js";
import { appContract } from "../rpc/app-contract.js";
import {
  IntegrationProviderConfigSchema,
  IntegrationSetupStateSchema,
} from "./integration-settings.js";

const status = {
  botId: "bot-1",
  mode: "team",
  state: "stopped",
  controlHolder: "none",
  controlBotId: null,
  takeoverRequested: false,
  screenAvailable: false,
  screenWidth: 1280,
  screenHeight: 800,
  homeRevision: null,
  busyBotName: null,
  canUpdate: true,
  terminalAvailable: false,
};

describe("provider ids are opaque strings", () => {
  it.each(["docker", "a-provider-added-later", "a-provider-since-removed"])(
    "carries the computer kind %s unchanged",
    (kind) => {
      expect(SandboxKind.parse(kind)).toBe(kind);
      expect(ComputerStatusSchema.parse({ ...status, kind }).kind).toBe(kind);
    },
  );

  it("still refuses a computer kind that is not a name", () => {
    for (const kind of ["", 7, null, undefined])
      expect(ComputerStatusSchema.safeParse({ ...status, kind }).success).toBe(false);
  });

  it("carries any integration provider and its credentials for the adapter to check", () => {
    const config = { provider: "a-provider-added-later", apiKey: " key ", region: "eu" };
    expect(IntegrationProviderConfigSchema.parse(config)).toEqual({ ...config, apiKey: "key" });
    expect(IntegrationProviderConfigSchema.safeParse({ apiKey: "key" }).success).toBe(false);
    expect(
      IntegrationProviderConfigSchema.safeParse({ provider: "one", apiKey: { nested: true } })
        .success,
    ).toBe(false);
    const state = {
      canConfigure: true,
      needsSetup: false,
      webUrl: "https://app.example.test/integrations/setup",
      providers: [{ id: "a-provider-since-removed", configured: true }],
    };
    expect(IntegrationSetupStateSchema.parse(state)).toEqual(state);
  });

  it("leaves the connector a request omits for the server to choose", () => {
    const begin = appContract.connections.begin["~orpc"].inputSchema!;
    expect(begin.parse({ provider: "gmail", displayName: "Gmail" })).toEqual({
      provider: "gmail",
      displayName: "Gmail",
    });
    expect(
      begin.parse({ connectorId: "one", provider: "gmail", displayName: "Gmail" }),
    ).toMatchObject({ connectorId: "one" });
    const connected = appContract.onboarding.appConnected["~orpc"].inputSchema!;
    expect(connected.parse({ botId: "bot-1", provider: "gmail" })).toEqual({
      botId: "bot-1",
      provider: "gmail",
    });
  });
});
