/**
 * The Lingui macro compiles away in the app build; tests run the source, so `t` just renders the
 * English template.
 */
export function t(strings: TemplateStringsArray, ...values: unknown[]): string {
  return String.raw(strings, ...values);
}
