import { createStoredPreference } from "./stored-preference";

export const COMPOSER_MODEL_PICKER_STORAGE_KEY = "rakazo.composerModelPicker";

/** Only a saved "on" shows the model in the message box; anything else keeps it off. */
export function normalizeComposerModelPicker(raw: string | null | undefined): boolean {
  return raw?.trim().toLowerCase() === "on";
}

export const composerModelPickerPreference = createStoredPreference({
  key: COMPOSER_MODEL_PICKER_STORAGE_KEY,
  parse: normalizeComposerModelPicker,
  serialize: (enabled) => (enabled ? "on" : "off"),
});
