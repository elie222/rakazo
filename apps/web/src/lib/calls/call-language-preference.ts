import { CALL_AUTO_LANGUAGE_KEY } from "@rakazo/core";
import { createStoredPreference } from "../preferences/stored-preference";

export const callAutoLanguage = createStoredPreference({
  key: CALL_AUTO_LANGUAGE_KEY,
  parse: (value) => value === "1",
  serialize: (enabled) => (enabled ? "1" : null),
});
