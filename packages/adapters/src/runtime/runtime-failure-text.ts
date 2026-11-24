/**
 * Text a runtime writes in place of an answer when the model call failed: an error it hit, or
 * a model it does not know. Callers that need an answer treat it as no answer.
 */
export function isRuntimeFailureText(text: string): boolean {
  return /^(?:I hit a problem:|Unknown model )/i.test(text.trim());
}
