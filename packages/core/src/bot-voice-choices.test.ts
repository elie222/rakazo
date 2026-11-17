import { expect, it } from "vitest";
import { botVoiceChoices, botVoiceProviderChoices } from "./bot-voice-choices.js";

const credentials = [
  { provider: "speech-b", voiceId: "bright", isDefault: false },
  { provider: "speech-a", voiceId: "calm", isDefault: true },
];
const catalog = [
  { id: "speech-a", name: "Speech A" },
  { id: "unconnected", name: "Unconnected" },
  { id: "speech-b", name: "Speech B" },
];

it("offers connected providers in connection order and follows the live default", () => {
  const inherited = botVoiceProviderChoices({ credentials, catalog, provider: null });
  expect(inherited.options).toEqual([
    { value: "speech-b", label: "Speech B" },
    { value: "speech-a", label: "Speech A" },
  ]);
  expect(inherited.connection?.provider).toBe("speech-a");
  expect(inherited.defaultLabel).toBe("Speech A");
  const changed = credentials.map((entry) => ({
    ...entry,
    isDefault: entry.provider === "speech-b",
  }));
  expect(
    botVoiceProviderChoices({ credentials: changed, catalog, provider: null }).connection?.provider,
  ).toBe("speech-b");
  expect(
    botVoiceProviderChoices({ credentials: changed, catalog, provider: "speech-a" }).connection
      ?.provider,
  ).toBe("speech-a");
});

it("keeps disconnected and unknown selections without falling back to another connection", () => {
  const disconnected = botVoiceProviderChoices({ credentials, catalog, provider: "unconnected" });
  expect(disconnected.connection).toBeUndefined();
  expect(disconnected.options.at(-1)).toEqual({ value: "unconnected", label: "Unconnected" });
  expect(botVoiceProviderChoices({ provider: "missing" }).options).toEqual([
    { value: "missing", label: "missing" },
  ]);
  expect(botVoiceProviderChoices({}).defaultLabel).toBeUndefined();
});

it("labels the Settings voice and preserves a saved voice missing from the catalog", () => {
  const voices = [{ id: "calm", label: "Calm" }];
  expect(botVoiceChoices({ voices, defaultVoiceId: "calm", voiceId: "retired" })).toEqual({
    options: [
      { value: "calm", label: "Calm" },
      { value: "retired", label: "retired" },
    ],
    defaultLabel: "Calm",
  });
  expect(voices).toEqual([{ id: "calm", label: "Calm" }]);
  expect(botVoiceChoices({ voices, defaultVoiceId: "missing", voiceId: "calm" })).toEqual({
    options: [{ value: "calm", label: "Calm" }],
    defaultLabel: "missing",
  });
  expect(botVoiceChoices({})).toEqual({ options: [], defaultLabel: undefined });
});
