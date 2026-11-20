// @vitest-environment jsdom

import type { Bot, VoiceCredential, VoiceStatus } from "@rakazo/contracts";
import { deferred, flush } from "@rakazo/core/test-async";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { act } from "react";
import type { Root } from "react-dom/client";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("@lingui/react/macro", () => ({
  useLingui: () => ({
    t: (parts: TemplateStringsArray, ...values: unknown[]) =>
      parts.reduce((text, part, index) => `${text}${index ? values[index - 1] : ""}${part}`, ""),
  }),
  Trans: ({ children }: { children: ReactNode }) => children,
}));
vi.mock("../../../lib/calls/call-session", () => ({ useCallSession: () => null }));
vi.mock("../../../lib/query/rpc", () => {
  const rpc = {
    bots: { get: vi.fn(), update: vi.fn(), list: vi.fn(async () => []) },
    bootstrap: vi.fn(async () => ({})),
    voice: {
      credentials: vi.fn(),
      catalog: vi.fn(),
      voices: vi.fn(),
      status: vi.fn(),
    },
  };
  return {
    rpc,
    rpcForSpace: () => rpc,
    createSpaceRpc: () => rpc,
    selectedSpaceId: () => "space-1",
  };
});

import { Speaker, speaker } from "../../../lib/calls/tts";
import { spaceQueries } from "../../../lib/query/query";
import { rpc } from "../../../lib/query/rpc";
import { BotVoiceSettings } from "./bot-voice-settings";

let bot: Bot;
let credentials: VoiceCredential[];
let container: HTMLDivElement;
let root: Root;
let client: QueryClient;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.restoreAllMocks();
  vi.clearAllMocks();
  bot = { id: "bot-1", spaceId: "space-1", name: "Ada", voiceProvider: null, voiceId: null } as Bot;
  credentials = [
    { id: "connection-a", provider: "speech-a", voiceId: "calm", isDefault: true },
    { id: "connection-b", provider: "speech-b", voiceId: "bright", isDefault: false },
  ] as VoiceCredential[];
  vi.mocked(rpc.bots.get).mockImplementation(async () => bot);
  vi.mocked(rpc.bots.update).mockImplementation(async (input) => {
    bot = { ...bot, ...input };
    return bot;
  });
  vi.mocked(rpc.voice.credentials).mockImplementation(async () => credentials);
  vi.mocked(rpc.voice.catalog).mockResolvedValue([
    { id: "speech-a", name: "Speech A", description: "", transcribe: true },
    { id: "speech-b", name: "Speech B", description: "", transcribe: false },
  ]);
  vi.mocked(rpc.voice.voices).mockImplementation(async (input) =>
    input.provider === "speech-b"
      ? [
          { id: "bright", label: "Bright" },
          { id: "warm", label: "Warm" },
        ]
      : [{ id: "calm", label: "Calm" }],
  );
  vi.mocked(rpc.voice.status).mockImplementation(async () => {
    const connection = bot.voiceProvider
      ? credentials.find((entry) => entry.provider === bot.voiceProvider)
      : credentials.find((entry) => entry.isDefault);
    const voiceId = bot.voiceId || connection?.voiceId || "";
    return {
      configured: Boolean(connection),
      ready: Boolean(connection && voiceId),
      transcribe: false,
      provider: connection?.provider ?? null,
      voiceId,
    };
  });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
});

afterEach(() => {
  act(() => root.unmount());
  speaker.stop();
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});

async function render(profile = bot) {
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <BotVoiceSettings bot={profile} />
      </QueryClientProvider>,
    ),
  );
  await act(flush);
  await act(async () => {
    await vi.waitFor(() => expect(client.isFetching()).toBe(0));
  });
  await act(flush);
}

it("refreshes same-bot roster changes without restoring an older detail or roster snapshot", async () => {
  const oldBot = bot;
  const oldRead = deferred<Bot>();
  vi.mocked(rpc.bots.get).mockReturnValue(oldRead.promise);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <BotVoiceSettings bot={oldBot} />
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await vi.waitFor(() => expect(rpc.bots.get).toHaveBeenCalled());
    await vi.waitFor(() =>
      expect(container.querySelector<HTMLButtonElement>('[id$="-provider"]')?.disabled).toBe(true),
    );
  });
  bot = { ...bot, voiceProvider: "speech-b", voiceId: "warm" };
  vi.mocked(rpc.bots.get).mockImplementation(async () => bot);
  await render();
  expect(container.querySelector('[id$="-provider"]')?.textContent).toBe("Speech B");
  expect(container.querySelector('[id$="-voice"]')?.textContent).toBe("Warm");

  await act(async () => oldRead.resolve(oldBot));
  await act(flush);
  expect(container.querySelector('[id$="-voice"]')?.textContent).toBe("Warm");
  await choose("voice", "Bright");
  await render(oldBot);
  expect(container.querySelector('[id$="-provider"]')?.textContent).toBe("Speech B");
  expect(container.querySelector('[id$="-voice"]')?.textContent).toBe("Bright");
  await choose("voice", "Warm");
  expect(rpc.bots.update).toHaveBeenLastCalledWith({
    botId: "bot-1",
    voiceProvider: "speech-b",
    voiceId: "warm",
  });
});

async function choose(suffix: string, label: string) {
  const selector = `[role="combobox"][id$="-${suffix}"]`;
  await act(async () => {
    await vi.waitFor(() =>
      expect(container.querySelector<HTMLButtonElement>(selector)?.disabled).toBe(false),
    );
  });
  const picker = container.querySelector<HTMLButtonElement>(selector)!;
  await act(async () => picker.click());
  let option: HTMLElement | undefined;
  await act(async () => {
    await vi.waitFor(() => {
      option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(
        (entry) => entry.textContent === label,
      );
      expect(option).toBeDefined();
    });
  });
  await act(async () => option!.click());
  await act(flush);
}

it("inherits live settings, clears a provider's voice when switching, and saves only this bot", async () => {
  await render();
  expect(container.textContent).toContain("Default (Speech A)");
  expect(container.textContent).toContain("Default (Calm)");
  await choose("provider", "Speech B");
  expect(bot.voiceProvider).toBe("speech-b");
  expect(bot.voiceId).toBeNull();
  expect(container.textContent).toContain("Default (Bright)");
  await choose("voice", "Warm");
  expect(bot.voiceId).toBe("warm");
  await choose("provider", "Default (Speech A)");
  expect(bot.voiceProvider).toBeNull();
  expect(bot.voiceId).toBeNull();
  credentials = credentials.map((entry) => ({
    ...entry,
    isDefault: entry.provider === "speech-b",
  }));
  await act(async () => {
    await client.invalidateQueries({
      queryKey: spaceQueries(null, "space-1").voice.credentials.queryKey(),
    });
  });
  await act(flush);
  expect(container.textContent).toContain("Default (Speech B)");
  expect(container.textContent).toContain("Default (Bright)");
  expect(rpc.bots.update).toHaveBeenLastCalledWith({
    botId: "bot-1",
    voiceProvider: null,
    voiceId: null,
  });
});

it("keeps the accepted voice after a failed save and previews that bot, not the global voice", async () => {
  bot = { ...bot, voiceProvider: "speech-b", voiceId: "warm" };
  const held = deferred<Bot>();
  vi.mocked(rpc.bots.update).mockReturnValueOnce(held.promise);
  const speak = vi.spyOn(Speaker.prototype, "speak").mockResolvedValue(undefined);
  vi.spyOn(Speaker.prototype, "unlock").mockImplementation(() => undefined);
  await render();
  await choose("voice", "Bright");
  const sample = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (button) => button.getAttribute("aria-label") === "Hear a sample",
  )!;
  expect(sample.disabled).toBe(true);
  await act(async () => held.reject(new Error("Could not save voice")));
  await act(flush);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("Could not save voice");
  expect(container.querySelector('[id$="-voice"]')?.textContent).toContain("Warm");
  await act(async () => sample.click());
  expect(speak).toHaveBeenCalledWith(expect.any(String), {
    botId: "bot-1",
    spaceId: "space-1",
    messageId: expect.any(String),
  });
});

it("shows only its current preview's shared playback error", async () => {
  const held = deferred<string[]>();
  vi.spyOn(speaker as unknown as { prepare: () => Promise<string[]> }, "prepare")
    .mockRejectedValueOnce(new Error("Could not play preview"))
    .mockReturnValueOnce(held.promise)
    .mockRejectedValueOnce(new Error("Could not read reply"));
  vi.spyOn(speaker, "unlock").mockImplementation(() => undefined);
  await render();
  const sample = container.querySelector<HTMLButtonElement>('[aria-label="Hear a sample"]')!;
  await act(async () => sample.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe("Could not play preview");
  expect(speaker.state.error).toBe("Could not play preview");

  await act(async () => sample.click());
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(sample.getAttribute("aria-label")).toBe("Stop");
  await act(async () => {
    await speaker.speak("A chat reply.", { botId: "bot-1", messageId: "message-1" });
    held.reject(new Error("Stale preview failure"));
  });
  await act(flush);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(sample.getAttribute("aria-label")).toBe("Hear a sample");
  const replyError = speaker.state;
  expect(replyError).toMatchObject({
    messageId: "message-1",
    error: "Could not read reply",
  });

  await choose("voice", "Calm");
  expect(speaker.state).toBe(replyError);
  act(() => root.render(null));
  expect(speaker.state).toBe(replyError);
});

it("pins a custom voice chosen under Default until the provider is reset", async () => {
  await render();
  await choose("voice", "Calm");
  expect(bot.voiceProvider).toBe("speech-a");
  expect(bot.voiceId).toBe("calm");
  credentials = credentials.map((entry) => ({
    ...entry,
    isDefault: entry.provider === "speech-b",
  }));
  await act(async () => {
    await client.invalidateQueries({
      queryKey: spaceQueries(null, "space-1").voice.credentials.queryKey(),
    });
  });
  await act(flush);
  expect(container.querySelector('[id$="-provider"]')?.textContent).toBe("Speech A");
  expect(container.querySelector('[id$="-voice"]')?.textContent).toBe("Calm");
  await choose("provider", "Default (Speech B)");
  expect(bot.voiceProvider).toBeNull();
  expect(bot.voiceId).toBeNull();
  expect(container.querySelector('[id$="-voice"]')?.textContent).toBe("Default (Bright)");
});

it("keeps the pinned provider when only its voice is reset to Settings", async () => {
  bot = { ...bot, voiceProvider: "speech-b", voiceId: "warm" };
  await render();
  await choose("voice", "Default (Bright)");
  expect(bot.voiceProvider).toBe("speech-b");
  expect(bot.voiceId).toBeNull();
  expect(container.querySelector('[id$="-provider"]')?.textContent).toBe("Speech B");
  expect(container.querySelector('[id$="-voice"]')?.textContent).toBe("Default (Bright)");
});

it("does not pin Settings when clearing a legacy inherited voice", async () => {
  bot = { ...bot, voiceId: "calm" };
  await render();
  await choose("voice", "Default (Calm)");
  expect(bot.voiceProvider).toBeNull();
  expect(bot.voiceId).toBeNull();
  expect(container.querySelector('[id$="-provider"]')?.textContent).toBe("Default (Speech A)");
});

it("waits for provider names instead of labeling connected choices unavailable", async () => {
  const names = await rpc.voice.catalog();
  const pending = deferred<typeof names>();
  vi.mocked(rpc.voice.catalog).mockReturnValueOnce(pending.promise);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <BotVoiceSettings bot={bot} />
      </QueryClientProvider>,
    ),
  );
  await act(async () => {
    await vi.waitFor(() =>
      expect(
        client.getQueryState(spaceQueries(null, "space-1").voice.credentials.queryKey())?.status,
      ).toBe("success"),
    );
  });
  expect(container.querySelector('[role="combobox"]')).toBeNull();
  expect(container.textContent).not.toContain("Unavailable");
  await act(async () => pending.resolve(names));
  await act(async () => {
    await vi.waitFor(() =>
      expect(container.querySelector('[id$="-provider"]')?.textContent).toBe("Default (Speech A)"),
    );
  });
});

it("previews ready included speech without offering unsupported edits", async () => {
  credentials = [];
  vi.mocked(rpc.voice.status).mockResolvedValue({
    configured: true,
    ready: true,
    transcribe: false,
    provider: "speech-a",
    voiceId: "calm",
  });
  const speak = vi.spyOn(Speaker.prototype, "speak").mockResolvedValue(undefined);
  vi.spyOn(Speaker.prototype, "unlock").mockImplementation(() => undefined);
  await render();

  expect(rpc.voice.status).toHaveBeenCalledWith({ botId: "bot-1" }, expect.anything());
  expect(rpc.voice.voices).toHaveBeenCalledWith({}, expect.anything());
  expect(container.textContent).toContain("Default (Speech A)");
  await act(async () => {
    await vi.waitFor(() => expect(container.textContent).toContain("Default (Calm)"));
  });
  expect(container.querySelector('[role="combobox"]')).toBeNull();
  expect(container.textContent).not.toContain("speech-a");
  expect(container.textContent).not.toContain("calm");
  const sample = container.querySelector<HTMLButtonElement>('[aria-label="Hear a sample"]')!;
  expect(sample.disabled).toBe(false);
  await act(async () => sample.click());
  expect(speak).toHaveBeenCalledWith(expect.any(String), {
    botId: "bot-1",
    spaceId: "space-1",
    messageId: expect.any(String),
  });
  expect(rpc.bots.update).not.toHaveBeenCalled();
});

it("can leave included speech for an owned connection and pin its custom voice", async () => {
  credentials = credentials.filter((entry) => !entry.isDefault);
  vi.mocked(rpc.voice.status).mockImplementation(async () => ({
    configured: true,
    ready: true,
    transcribe: false,
    provider: bot.voiceProvider || "speech-a",
    voiceId: bot.voiceId || (bot.voiceProvider ? "bright" : "calm"),
  }));
  await render();

  expect(container.querySelector('[id$="-provider"]')?.textContent).toBe("Default (Speech A)");
  await act(async () => {
    await vi.waitFor(() =>
      expect(container.querySelector('[id$="-voice"]')?.textContent).toBe("Default (Calm)"),
    );
  });
  expect(container.querySelector('[role="combobox"][id$="-voice"]')).toBeNull();
  await choose("provider", "Speech B");
  expect(bot.voiceProvider).toBe("speech-b");
  expect(rpc.voice.voices).toHaveBeenCalledWith({ provider: "speech-b" }, expect.anything());
  await choose("voice", "Warm");
  expect(bot.voiceProvider).toBe("speech-b");
  expect(bot.voiceId).toBe("warm");
});

it("does not use included speech for a disconnected saved provider", async () => {
  bot = { ...bot, voiceProvider: "speech-b", voiceId: "warm" };
  credentials = [];
  vi.mocked(rpc.voice.status).mockResolvedValue({
    configured: false,
    ready: false,
    transcribe: false,
    provider: null,
    voiceId: "",
  });
  await render();

  expect(container.querySelector('[id$="-provider"]')?.textContent).toBe("Speech B");
  expect(container.querySelector('[aria-label="Hear a sample"]')?.hasAttribute("disabled")).toBe(
    true,
  );
  expect(container.querySelector('[role="alert"]')?.textContent).toBe(
    "Reconnect this provider in Settings → Voice.",
  );
  expect(rpc.voice.voices).not.toHaveBeenCalled();
  await choose("provider", "Default");
  expect(bot.voiceProvider).toBeNull();
  expect(bot.voiceId).toBeNull();
  expect(container.textContent).toBe("");
});

it("waits for included speech readiness before offering a sample", async () => {
  credentials = [];
  const pending = deferred<VoiceStatus>();
  vi.mocked(rpc.voice.status).mockReturnValueOnce(pending.promise);
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <BotVoiceSettings bot={bot} />
      </QueryClientProvider>,
    ),
  );
  await act(flush);
  expect(container.querySelector("button")).toBeNull();
  expect(rpc.voice.voices).not.toHaveBeenCalled();
  await act(async () =>
    pending.resolve({
      configured: true,
      ready: true,
      transcribe: false,
      provider: "speech-a",
      voiceId: "calm",
    }),
  );
  await act(async () => {
    await vi.waitFor(() =>
      expect(
        container.querySelector<HTMLButtonElement>('[aria-label="Hear a sample"]')?.disabled,
      ).toBe(false),
    );
  });
  expect(container.textContent).toContain("Default (Calm)");
});

it.each([false, true])(
  "keeps speech without a ready voice quiet (configured: %s)",
  async (configured) => {
    credentials = [];
    vi.mocked(rpc.voice.status).mockResolvedValue({
      configured,
      ready: false,
      transcribe: false,
      provider: configured ? "speech-a" : null,
      voiceId: "",
    });
    await render();
    expect(container.textContent).toBe("");
    expect(container.querySelector("button")).toBeNull();
    expect(rpc.voice.status).toHaveBeenCalledWith({ botId: "bot-1" }, expect.anything());
    expect(rpc.voice.voices).not.toHaveBeenCalled();
  },
);
