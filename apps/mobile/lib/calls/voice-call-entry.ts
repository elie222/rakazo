import { displayName } from "@rakazo/core";
export type VoiceCallStatus = { ready: boolean; transcribe: boolean };

export type VoiceCallPlan =
  | { kind: "device"; transcribe: false }
  | { kind: "provider"; transcribe: boolean }
  | { kind: "settings" }
  | { kind: "dictation" };

export type VoiceCallPlanDeps = {
  loadDeviceVoiceEnabled: (loadVoiceStatus: () => Promise<VoiceCallStatus>) => Promise<boolean>;
  dictationAvailable: () => Promise<boolean>;
  loadVoiceStatus: () => Promise<VoiceCallStatus>;
};

/**
 * Chooses the call input/output path before any provider setup is required.
 * A device voice preference is fail-closed like speakText: a read failure must
 * not turn a local-only reply into hosted voice traffic.
 */
export async function resolveVoiceCallPlan(
  deps: VoiceCallPlanDeps,
  purpose: "call" | "dictation" = "call",
): Promise<VoiceCallPlan> {
  let voiceStatus: Promise<VoiceCallStatus> | undefined;
  const loadVoiceStatus = () => (voiceStatus ??= deps.loadVoiceStatus());
  let deviceVoiceEnabled = false;
  try {
    deviceVoiceEnabled = await deps.loadDeviceVoiceEnabled(loadVoiceStatus);
  } catch {
    deviceVoiceEnabled = true;
  }

  const deviceDictationAvailable = deviceVoiceEnabled ? await deps.dictationAvailable() : false;
  if (deviceVoiceEnabled && deviceDictationAvailable) {
    return { kind: "device", transcribe: false };
  }

  const status = await loadVoiceStatus();
  // Device speech only needs hosted transcription when native recognition is unavailable.
  if (!status.ready && !(status.transcribe && (deviceVoiceEnabled || purpose === "dictation"))) {
    return deviceVoiceEnabled ? { kind: "dictation" } : { kind: "settings" };
  }

  if (!status.transcribe) {
    const canDictate = deviceVoiceEnabled
      ? deviceDictationAvailable
      : await deps.dictationAvailable();
    if (!canDictate) return { kind: "dictation" };
  }

  return { kind: "provider", transcribe: status.transcribe };
}

/** Device speech can use server transcription even when the bot has no hosted speaking voice. */
export async function probeProviderTranscribe(
  loadVoiceStatus: () => Promise<VoiceCallStatus>,
): Promise<boolean> {
  try {
    const status = await loadVoiceStatus();
    return status.transcribe;
  } catch {
    return false;
  }
}

/** Personalize the greeting only when the profile arrives within 500 ms. */
export async function loadCallCallerName(
  loadMe: () => Promise<{ name?: string | null }>,
): Promise<string | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const me = await Promise.race([
      loadMe(),
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), 500);
      }),
    ]);
    return displayName(me?.name, "").split(/\s+/)[0] || undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
