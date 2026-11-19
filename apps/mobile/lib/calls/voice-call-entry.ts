import { displayName } from "@rakazo/core";
export type VoiceCallStatus = { ready: boolean; transcribe: boolean };

export type VoiceCallPlan =
  | { kind: "device"; transcribe: boolean }
  | { kind: "provider"; transcribe: boolean }
  | { kind: "settings" }
  | { kind: "dictation" };

export type VoiceCallPlanDeps = {
  autoLanguage?: boolean;
  loadDeviceVoiceEnabled: () => Promise<boolean>;
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
  let deviceVoiceEnabled = false;
  try {
    deviceVoiceEnabled = await deps.loadDeviceVoiceEnabled();
  } catch {
    deviceVoiceEnabled = true;
  }

  const autoLanguage = purpose === "call" && deps.autoLanguage;
  const deviceDictationAvailable =
    deviceVoiceEnabled && !autoLanguage && (await deps.dictationAvailable());
  if (deviceVoiceEnabled && deviceDictationAvailable) {
    return { kind: "device", transcribe: false };
  }

  const status = await deps.loadVoiceStatus();
  if (autoLanguage && !status.transcribe) return { kind: "dictation" };
  if (deviceVoiceEnabled && autoLanguage) {
    return { kind: "device", transcribe: status.transcribe };
  }
  if (!status.ready && !(purpose === "dictation" && status.transcribe)) {
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

/** True only when the provider is ready to transcribe. Any other outcome is false. */
export async function probeProviderTranscribe(
  loadVoiceStatus: () => Promise<VoiceCallStatus>,
): Promise<boolean> {
  try {
    const status = await loadVoiceStatus();
    return status.ready && status.transcribe;
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
