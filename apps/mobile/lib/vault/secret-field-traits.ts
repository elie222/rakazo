import type { SecretAskPurpose } from "@rakazo/contracts";
import type { TextInputProps } from "react-native";

export type SecretFieldTraits = Required<Pick<TextInputProps, "textContentType" | "autoComplete">>;

/**
 * The iOS AutoFill traits for a masked secret field. A website login and a password offer saved
 * passwords. A connector code (no credential) offers the one-time code from Messages or Mail; a
 * code saved for a site the bot named, an API key and a command variable offer nothing.
 */
export function secretFieldTraits(
  purpose: SecretAskPurpose | undefined,
  credential: { auth: { type: string } } | undefined,
): SecretFieldTraits {
  const auth = credential?.auth.type;
  if (auth === "login" || (purpose === "password" && auth !== "command")) {
    return { textContentType: "password", autoComplete: "current-password" };
  }
  if (credential || purpose === "api_key") {
    return { textContentType: "none", autoComplete: "off" };
  }
  return { textContentType: "oneTimeCode", autoComplete: "one-time-code" };
}

/** A hidden login value offers saved passwords; a visible one is plain text. */
export function loginFieldTraits(hidden: boolean): SecretFieldTraits {
  return hidden
    ? secretFieldTraits("password", { auth: { type: "login" } })
    : { textContentType: "none", autoComplete: "off" };
}
