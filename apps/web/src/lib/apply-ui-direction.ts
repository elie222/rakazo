import { textDirectionForLocale } from "@rakazo/core";
import { resolveUiLocale } from "./ui-locale";

export function applyUiDirection(locale = resolveUiLocale()) {
  const direction = textDirectionForLocale(locale);
  document.documentElement.dir = direction;
  document.documentElement.lang = locale;
  return direction;
}
