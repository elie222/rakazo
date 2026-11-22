import { bestEffort } from "@rakazo/logging/best-effort";
import * as SecureStore from "expo-secure-store";
import { rpc } from "../api/api";

export const DEVICE_VOICE_KEY = "rakazo.device-voice";

// Counts explicit choices, so a default worked out meanwhile never overwrites one.
let choices = 0;
let lastWrite: Promise<unknown> = Promise.resolve();
let choiceSaving: Promise<unknown> | undefined;
const choiceListeners = new Set<() => void>();

function write(on: boolean): Promise<void> {
  const next = lastWrite.then(() => SecureStore.setItemAsync(DEVICE_VOICE_KEY, on ? "1" : "0"));
  lastWrite = next.catch(() => undefined);
  return next;
}

/**
 * Until someone picks a voice, the phone's own is used unless a hosted voice is already set up,
 * so earlier installs keep the provider they connected. The first answer is kept, so later
 * replies don't wait on the server to decide.
 */
export async function loadDeviceVoiceEnabled(): Promise<boolean> {
  // A choice still being written must be what this read sees, not a default written over it.
  if (choiceSaving) await choiceSaving;
  const seen = choices;
  const stored = await SecureStore.getItemAsync(DEVICE_VOICE_KEY);
  if (stored) return stored === "1";
  let ready: boolean;
  try {
    ready = (await rpc("voice/status", { scope: "account" })).ready;
  } catch {
    return true;
  }
  if (choices !== seen) return loadDeviceVoiceEnabled();
  await write(!ready).catch(() => undefined);
  return !ready;
}

export function saveDeviceVoiceEnabled(on: boolean): Promise<void> {
  choices += 1;
  const saved = write(on);
  const settled = lastWrite;
  choiceSaving = settled;
  void settled.then(() => {
    if (choiceSaving === settled) choiceSaving = undefined;
  });
  for (const listener of choiceListeners) {
    void bestEffort(
      "device voice choice listener",
      new Promise<void>((resolve) => resolve(listener())),
    );
  }
  return saved;
}

export function subscribeDeviceVoiceChoice(listener: () => void): () => void {
  choiceListeners.add(listener);
  return () => choiceListeners.delete(listener);
}
