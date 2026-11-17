import type { LoginSecretValue } from "@rakazo/contracts";
import type { AdapterDescriptor } from "./types.js";

/** The source could not be reached or gave an answer that cannot be used. Asking again may work. */
export class CredentialSourceUnavailableError extends Error {
  readonly code = "CREDENTIAL_SOURCE_UNAVAILABLE";
  constructor(message = "The credential source is unavailable", options?: ErrorOptions) {
    super(message, options);
    this.name = "CredentialSourceUnavailableError";
  }
}

/** The source refused the connection's credentials. Asking again with them cannot work. */
export class CredentialSourceRefusedError extends Error {
  readonly code = "CREDENTIAL_SOURCE_REFUSED";
  constructor(message = "The credential source refused the saved connection") {
    super(message);
    this.name = "CredentialSourceRefusedError";
  }
}

/** The item is no longer in the source, or has nothing a login can use. */
export class CredentialSourceItemGoneError extends Error {
  readonly code = "CREDENTIAL_SOURCE_ITEM_GONE";
  constructor(message = "The linked item is no longer available") {
    super(message);
    this.name = "CredentialSourceItemGoneError";
  }
}

/** An item in a credential source that can be linked as a login. Never carries its values. */
export interface CredentialSourceItem {
  /** The source's own stable address for the item; only that source can read it back. */
  ref: string;
  title: string;
  /** The site the item names, when it names one. */
  url?: string;
}

/**
 * A read-only outside password manager whose logins a vault can link to. Values are read when
 * they are used and never kept: an adapter holds no plaintext between calls, and a failure is
 * thrown, never answered with an empty or stale value.
 */
export interface CredentialSource {
  describe(): AdapterDescriptor<{ readOnly: true }>;
  /** Logins that can be linked, in the order the source gives them. Never values. */
  listItems(signal: AbortSignal): Promise<CredentialSourceItem[]>;
  /** The login an item holds now. Throws when the item is gone or has no usable password. */
  resolve(ref: string, signal: AbortSignal): Promise<LoginSecretValue>;
}
