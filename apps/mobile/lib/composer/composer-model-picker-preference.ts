import { createDeviceBooleanPreference } from "./device-boolean-preference";

export const COMPOSER_MODEL_PICKER_STORAGE_KEY = "rakazo.composerModelPicker";

const preference = createDeviceBooleanPreference(COMPOSER_MODEL_PICKER_STORAGE_KEY, false);

export const {
  get: getCachedComposerModelPicker,
  load: loadComposerModelPickerPreference,
  set: setComposerModelPicker,
  subscribe: subscribeComposerModelPicker,
} = preference;
