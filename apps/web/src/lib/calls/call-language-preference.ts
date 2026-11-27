import { callAutoLanguagePreference } from "@rakazo/core";
import { createStoredPreference } from "../preferences/stored-preference";

export const callAutoLanguage = createStoredPreference(callAutoLanguagePreference);
