import type { BotSecretMetadata, LoginFieldInput } from "@rakazo/contracts";
import {
  BotSecretName,
  commandVariableName,
  commandVariableProblem,
  encodeLoginSecret,
  LoginSecretValue,
} from "@rakazo/contracts";
import { secretDestinationLabel } from "./secret-destination";

export type CredentialAuth = NonNullable<BotSecretMetadata["auth"]>;
export type CredentialType = CredentialAuth["type"];
export type CredentialDestination = { name: string; origin?: string; auth: CredentialAuth };

/** What the add form collects besides the protected values. */
export type CredentialDraft = {
  name: string;
  origin: string;
  type: CredentialType;
  headerName: string;
  basicUsername: string;
};

/** The protected fields: held only in the form's state and cleared on every submit or close. */
export type CredentialSecret = { value: string; fields: readonly LoginFieldInput[] };

export const EMPTY_DRAFT: CredentialDraft = {
  name: "",
  origin: "",
  type: "bearer",
  headerName: "",
  basicUsername: "",
};

/** A saved credential that can be replaced: its settings still read and its name still saves. */
export function readableCredential(
  secret: BotSecretMetadata,
): (BotSecretMetadata & { auth: CredentialAuth }) | null {
  return secret.auth !== null && BotSecretName.safeParse(secret.name).success
    ? { ...secret, auth: secret.auth }
    : null;
}

/** The muted line under a credential's name: its site, or the variable a command receives. */
export function credentialDetail(secret: BotSecretMetadata): string {
  return secret.auth ? secretDestinationLabel({ ...secret, auth: secret.auth }) : secret.origin;
}

/** Why the typed name cannot be saved, once there is one. */
export function credentialNameProblem(draft: CredentialDraft): "invalid" | "reserved" | undefined {
  const name = draft.name.trim();
  if (!name) return undefined;
  if (!BotSecretName.safeParse(name).success) return "invalid";
  if (draft.type === "command" && commandVariableProblem(commandVariableName(name))) {
    return "reserved";
  }
  return undefined;
}

export function credentialAuth(draft: CredentialDraft): CredentialAuth {
  switch (draft.type) {
    case "header":
      return { type: "header", name: draft.headerName.trim() };
    case "basic":
      return { type: "basic", username: draft.basicUsername.trim() };
    case "login":
      return { type: "login" };
    case "command":
      return { type: "command" };
    default:
      return { type: "bearer" };
  }
}

/** A command variable has no site, so its destination carries no origin. */
export function credentialDestination(
  name: string,
  origin: string,
  auth: CredentialAuth,
): CredentialDestination {
  return auth.type === "command" ? { name, auth } : { name, origin, auth };
}

export function draftDestination(draft: CredentialDraft): CredentialDestination {
  return credentialDestination(draft.name.trim(), draft.origin.trim(), credentialAuth(draft));
}

export function secretReady(type: CredentialType, secret: CredentialSecret): boolean {
  return type === "login"
    ? LoginSecretValue.safeParse({ fields: secret.fields }).success
    : secret.value.length > 0;
}

export function draftReady(draft: CredentialDraft, secret: CredentialSecret): boolean {
  return (
    draft.name.trim().length > 0 &&
    !credentialNameProblem(draft) &&
    (draft.type === "command" || draft.origin.trim().length > 0) &&
    (draft.type !== "header" || draft.headerName.trim().length > 0) &&
    (draft.type !== "basic" || draft.basicUsername.trim().length > 0) &&
    secretReady(draft.type, secret)
  );
}

/** The stored value: a website login is saved as its encoded fields. */
export function credentialValue(type: CredentialType, secret: CredentialSecret): string {
  return type === "login"
    ? encodeLoginSecret({
        fields: secret.fields.map(({ label, value, hidden }) => ({ label, value, hidden })),
      })
    : secret.value;
}

/** Puts a saved credential in the list, replacing the one with its name. */
export function withCredential(
  list: readonly BotSecretMetadata[],
  saved: BotSecretMetadata,
): BotSecretMetadata[] {
  return list.some((entry) => entry.name === saved.name)
    ? list.map((entry) => (entry.name === saved.name ? saved : entry))
    : [...list, saved];
}
