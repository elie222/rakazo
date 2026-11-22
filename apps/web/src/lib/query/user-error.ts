import { errorHelpUrl } from "@rakazo/core";
import { errorText } from "@rakazo/i18n/user-error";

export { errorCode } from "@rakazo/core";
export {
  authErrorText,
  credentialIssueText,
  errorText,
  voiceAccountErrorText,
} from "@rakazo/i18n/user-error";

/** Keep the documented error code's help link when turning a failure into UI copy. */
export function errorDetails(error: unknown, fallback?: string) {
  return { message: errorText(error, fallback), helpUrl: errorHelpUrl(error) };
}

export type ErrorDetails = ReturnType<typeof errorDetails>;
