// @vitest-environment jsdom

import type { ThinkingLevel } from "@rakazo/contracts";
import { act, createElement } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { rpc } from "./api";
import type { ComposerModelRef, ComposerThinkingLevelControl } from "./composer-thinking-level";
import {
  resolveComposerThinkingLevel,
  saveComposerThinkingLevel,
  useComposerThinkingLevel,
} from "./composer-thinking-level";
import type { MobileBot, MobileModel, MobileModelCredential } from "./mobile-types";

vi.mock("./api", () => ({
  rpc: vi.fn(),
}));

function bot(overrides: Partial<MobileBot> = {}): MobileBot {
  return {
    modelProvider: "anthropic",
    modelId: "claude-x",
    thinkingLevel: null,
    ...overrides,
  } as MobileBot;
}

function catalogEntry(provider: string, id: string, thinkingLevels?: ThinkingLevel[]): MobileModel {
  return { provider, id, thinkingLevels } as MobileModel;
}

function credential(overrides: Partial<MobileModelCredential> = {}): MobileModelCredential {
  return {
    provider: "openai-compatible",
    label: "GB",
    modelId: "krisphyn-Kimi-K2.6",
    isDefault: true,
    reasoning: true,
    apiProtocol: "chat-completions",
    ...overrides,
  } as MobileModelCredential;
}

describe("resolveComposerThinkingLevel", () => {
  const catalog = [
    catalogEntry("anthropic", "claude-x", ["low", "medium", "high"]),
    catalogEntry("anthropic", "claude-lite", ["low", "medium"]),
    catalogEntry("anthropic", "claude-plain"),
  ];

  it("keeps the bot's level when the catalog model offers it", () => {
    expect(
      resolveComposerThinkingLevel({
        bot: bot({ thinkingLevel: "high" }),
        mainOverride: null,
        catalog,
        credentials: [],
      }),
    ).toEqual({ levels: ["low", "medium", "high"], value: "high" });
  });

  it("clamps a level the model does not offer to the nearest one", () => {
    expect(
      resolveComposerThinkingLevel({
        bot: bot({ modelId: "claude-lite", thinkingLevel: "high" }),
        mainOverride: null,
        catalog,
        credentials: [],
      }),
    ).toEqual({ levels: ["low", "medium"], value: "medium" });
  });

  it("reads an unset level as the default", () => {
    expect(
      resolveComposerThinkingLevel({
        bot: bot(),
        mainOverride: null,
        catalog,
        credentials: [],
      }),
    ).toEqual({ levels: ["low", "medium", "high"], value: "" });
  });

  it("reads off as the default", () => {
    expect(
      resolveComposerThinkingLevel({
        bot: bot({ thinkingLevel: "off" }),
        mainOverride: null,
        catalog,
        credentials: [],
      }),
    ).toEqual({ levels: ["low", "medium", "high"], value: "" });
  });

  it("hides the button for a model without thinking levels", () => {
    expect(
      resolveComposerThinkingLevel({
        bot: bot({ modelId: "claude-plain", thinkingLevel: "high" }),
        mainOverride: null,
        catalog,
        credentials: [],
      }),
    ).toBeNull();
  });

  it("hides the button for a model outside the catalog", () => {
    expect(
      resolveComposerThinkingLevel({
        bot: bot({ modelProvider: "unknown", modelId: "custom-1" }),
        mainOverride: null,
        catalog,
        credentials: [],
      }),
    ).toBeNull();
  });

  it("hides the button when the bot has no model", () => {
    expect(
      resolveComposerThinkingLevel({
        bot: bot({ modelProvider: null, modelId: null }),
        mainOverride: null,
        catalog,
        credentials: [],
      }),
    ).toBeNull();
    expect(
      resolveComposerThinkingLevel({
        bot: undefined,
        mainOverride: null,
        catalog,
        credentials: [],
      }),
    ).toBeNull();
  });

  it("follows a just-saved model instead of the bot's model", () => {
    const override: ComposerModelRef = { provider: "anthropic", modelId: "claude-lite" };
    expect(
      resolveComposerThinkingLevel({
        bot: bot({ thinkingLevel: "high" }),
        mainOverride: override,
        catalog,
        credentials: [],
      }),
    ).toEqual({ levels: ["low", "medium"], value: "medium" });
  });

  it("takes compatible levels from the connection when reasoning is on", () => {
    expect(
      resolveComposerThinkingLevel({
        bot: bot({
          modelProvider: "openai-compatible",
          modelId: "krisphyn-Kimi-K2.6",
          thinkingLevel: "xhigh",
        }),
        mainOverride: null,
        catalog: [],
        credentials: [credential()],
      }),
    ).toEqual({
      levels: ["minimal", "low", "medium", "high", "xhigh", "max"],
      value: "xhigh",
    });
  });

  it("drops the top levels for the Anthropic wire protocol", () => {
    expect(
      resolveComposerThinkingLevel({
        bot: bot({
          modelProvider: "openai-compatible",
          modelId: "krisphyn-Kimi-K2.6",
          thinkingLevel: "max",
        }),
        mainOverride: null,
        catalog: [],
        credentials: [credential({ apiProtocol: "anthropic-messages" })],
      }),
    ).toEqual({ levels: ["minimal", "low", "medium", "high"], value: "high" });
  });

  it("hides the button when the compatible connection has reasoning off", () => {
    expect(
      resolveComposerThinkingLevel({
        bot: bot({ modelProvider: "openai-compatible", modelId: "krisphyn-Kimi-K2.6" }),
        mainOverride: null,
        catalog: [],
        credentials: [credential({ reasoning: false })],
      }),
    ).toBeNull();
  });
});

describe("saveComposerThinkingLevel", () => {
  beforeEach(() => {
    vi.mocked(rpc).mockReset();
    vi.mocked(rpc).mockResolvedValue(undefined as never);
  });

  it("saves the picked level for the bot", async () => {
    await saveComposerThinkingLevel("bot-1", "high");
    expect(rpc).toHaveBeenCalledWith("bots/update", {
      botId: "bot-1",
      thinkingLevel: "high",
    });
  });

  it("saves null to restore the default", async () => {
    await saveComposerThinkingLevel("bot-1", "");
    expect(rpc).toHaveBeenCalledWith("bots/update", { botId: "bot-1", thinkingLevel: null });
  });
});

describe("useComposerThinkingLevel", () => {
  let root: Root;
  let latest: ComposerThinkingLevelControl;
  let props: {
    botId: string | undefined;
    bot: MobileBot | undefined;
    mainOverride: ComposerModelRef | null;
    catalog: MobileModel[] | null;
    credentials: MobileModelCredential[] | null;
  };

  function render() {
    function Harness() {
      latest = useComposerThinkingLevel(props);
      return null;
    }
    act(() => root.render(createElement(Harness)));
  }

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(rpc).mockReset();
    vi.mocked(rpc).mockResolvedValue(undefined as never);
    root = createRoot(document.createElement("div"));
    props = {
      botId: "bot-1",
      bot: bot({ thinkingLevel: "low" }),
      mainOverride: null,
      catalog: [catalogEntry("anthropic", "claude-x", ["low", "medium", "high"])],
      credentials: [],
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  });

  it("saves the picked level and shows it at once", async () => {
    render();
    expect(latest.state?.value).toBe("low");
    await act(async () => {
      await latest.save("high");
    });
    expect(rpc).toHaveBeenCalledWith("bots/update", {
      botId: "bot-1",
      thinkingLevel: "high",
    });
    expect(latest.state?.value).toBe("high");
  });

  it("puts the checkmark back when the save fails", async () => {
    render();
    vi.mocked(rpc).mockRejectedValueOnce(new Error("down"));
    await act(async () => {
      await latest.save("high");
    });
    expect(latest.state?.value).toBe("low");
  });

  it("clears the saved level once the bot list catches up", async () => {
    render();
    await act(async () => {
      await latest.save("high");
    });
    expect(latest.state?.value).toBe("high");
    props = { ...props, bot: bot({ thinkingLevel: "high" }) };
    render();
    expect(latest.state?.value).toBe("high");
  });
});
