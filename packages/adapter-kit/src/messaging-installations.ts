import type { MessagingSurface } from "./interfaces.js";
import type { MessagingPlatformDescriptor } from "./types.js";

/** A verified external workspace belongs to exactly one Rakazo space. */
export interface MessagingInstallation {
  id: string;
  provider: string;
  workspaceId: string;
  workspaceName: string;
  spaceId: string;
  userId: string;
  botId: string;
  credential: string;
}

export interface MessagingInstallationStore {
  get(provider: string, workspaceId: string): Promise<MessagingInstallation | null>;
  removeWorkspace(provider: string, workspaceId: string): Promise<void>;
  getById(id: string): Promise<MessagingInstallation | null>;
}

/**
 * The person cannot finish this workspace install as asked: the link is wrong, expired or already
 * used, or the workspace belongs elsewhere. Any other failure to finish one is a fault.
 */
export class MessagingInstallRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MessagingInstallRefusedError";
  }
}

/** Vendor OAuth and credential translation stay in adapters. */
export interface MessagingInstallProvider extends MessagingPlatformDescriptor {
  authorizeUrl(state: string): string;
  /**
   * `ownerId` is the workspace user who authorized the install, when the platform says. Throws
   * `MessagingInstallRefusedError` when the platform refuses the code for a reason the person can
   * act on.
   */
  exchange(code: string): Promise<{
    workspaceId: string;
    workspaceName: string;
    credential: string;
    ownerId?: string;
  }>;
  parseWebhook(
    request: Request,
  ): Promise<{ request: Request; workspaceId?: string; challenge?: string; uninstalled?: boolean }>;
  surface(credential: string): MessagingSurface;
}
