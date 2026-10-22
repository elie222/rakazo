import { appConnectedInput } from "@rakazo/core";
import { describe, expect, it } from "vitest";
import { appConnectPresentation } from "./app-connect.js";

describe("appConnectPresentation", () => {
  const block = {
    kind: "app_connect" as const,
    provider: "gmail",
    name: "Gmail",
    description: "Search, read, draft, and send email.",
    logo: null,
    status: "pending" as const,
  };

  it("renders an authorize control for pending app_connect blocks", () => {
    const view = appConnectPresentation(block);
    expect(view.showAuthorize).toBe(true);
    expect(view.actionLabel).toBe("Authorize");
  });

  it("hides authorize once connected", () => {
    const view = appConnectPresentation({ ...block, status: "connected" });
    expect(view.showAuthorize).toBe(false);
    expect(view.actionLabel).toBe("Connected");
  });
});

it("marks a normal chat card using the message thread", () => {
  expect(
    appConnectedInput("bot", "normal-chat", {
      kind: "app_connect",
      connectorId: "fake",
      provider: "gmail",
      name: "Gmail",
      description: "",
      logo: null,
      status: "pending",
    }),
  ).toEqual({ botId: "bot", threadId: "normal-chat", connectorId: "fake", provider: "gmail" });
});
