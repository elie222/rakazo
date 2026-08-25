export function resolveUiLocale(): string {
  return navigator.language ?? "en";
}
