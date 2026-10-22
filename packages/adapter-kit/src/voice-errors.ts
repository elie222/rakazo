import type { VoiceAccountErrorCode } from "@rakazo/contracts";

/** The user's voice provider account is out of credit or rejected the key; not a server fault. */
export class VoiceAccountError extends Error {
  constructor(
    readonly code: VoiceAccountErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "VoiceAccountError";
  }
}
