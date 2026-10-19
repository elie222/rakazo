import type {
  AuthOperationOptions,
  Credential,
  CredentialInfo,
  CredentialStore,
  OAuthCredential,
} from "@earendil-works/pi-ai";
import type {
  AgentModelOAuthCredential,
  ModelCredentialFailedState,
  ModelCredentialRetireReason,
} from "@rakazo/adapter-kit";
import { getLogger } from "@rakazo/logging";
import {
  OAUTH_ACCOUNT_CHANGED_ERROR,
  oauthCredentialAccountId,
  RetiredModelCredentialError,
  terminalOAuthRefreshErrorMarker,
} from "./pi-oauth.js";

export function toOAuthCredential(value: AgentModelOAuthCredential): OAuthCredential {
  return { ...value, type: "oauth" };
}

/**
 * Request-scoped Pi store for one already-authorized provider. Pi's default
 * in-memory store cannot see Rakazo's encrypted database; refreshes are
 * serialized here and published back for encryption.
 */
export class PiRuntimeCredentialStore implements CredentialStore {
  private credential?: Credential;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly providerId: string,
    credential?: Credential,
    private readonly persistOAuth?: (credential: OAuthCredential) => Promise<void>,
    private readonly retireOAuth?: (
      reason: ModelCredentialRetireReason,
      detail?: string,
      failed?: ModelCredentialFailedState,
    ) => Promise<boolean | undefined>,
  ) {
    this.credential = credential;
  }

  /**
   * The token a request resolves to right now. `modify` swaps the stored
   * credential on refresh, so callers must read this per request rather than
   * caching the credential they seeded the store with.
   */
  get accessToken(): string | undefined {
    return this.credential?.type === "oauth" ? this.credential.access : undefined;
  }

  async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    options?.signal?.throwIfAborted();
    return providerId === this.providerId ? this.credential : undefined;
  }

  async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    options?.signal?.throwIfAborted();
    return this.credential ? [{ providerId: this.providerId, type: this.credential.type }] : [];
  }

  modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    if (providerId !== this.providerId) return Promise.resolve(undefined);
    const previous = this.chain;
    const operation = previous.then(async () => {
      options?.signal?.throwIfAborted();
      const current = this.credential;
      let next: Credential | undefined;
      try {
        next = await fn(current);
      } catch (error) {
        const marker = terminalOAuthRefreshErrorMarker(error);
        if (marker && this.retireOAuth) {
          // The in-flight request is already failing. Await the retirement so
          // the delete commits before this error surfaces — a detached delete
          // could still be observed by a concurrent catalog read or be dropped
          // by worker shutdown. A retire failure never masks the refresh error.
          try {
            await this.retireOAuth(
              "terminal-refresh-failure",
              marker,
              current?.type === "oauth" ? current : undefined,
            );
          } catch (retireError) {
            getLogger().error("model credential retirement failed", retireError);
          }
        }
        throw error;
      }
      options?.signal?.throwIfAborted();
      if (next !== undefined) {
        if (next.type === "oauth" && next !== current) {
          const storedAccountId =
            current?.type === "oauth" ? oauthCredentialAccountId(current) : undefined;
          const refreshedAccountId = oauthCredentialAccountId(next);
          if (storedAccountId && refreshedAccountId && storedAccountId !== refreshedAccountId) {
            // The refresh succeeded but belongs to a different account: retire
            // the stored credential so the next run sees the provider
            // disconnected, and fail this run instead of persisting or using
            // the new token. Await the retirement so the delete commits before
            // the error surfaces, and fence on the stored credential state so
            // a concurrent successful refresh is not deleted underneath it. A
            // retire failure is logged and never masks the account-change error.
            let deleted = false;
            if (this.retireOAuth) {
              try {
                deleted =
                  (await this.retireOAuth(
                    "account-changed",
                    `stored account ${storedAccountId}, refreshed account ${refreshedAccountId}`,
                    current?.type === "oauth" ? current : undefined,
                  )) === true;
              } catch (retireError) {
                // A retire failure is logged and never masks the account-change
                // error. Leave it unmarked so the run can retry.
                getLogger().error("model credential retirement failed", retireError);
              }
            }
            // Fail the run permanently only when this call deleted the stored
            // credential. A skipped delete means a newer credential survived.
            if (deleted) throw new RetiredModelCredentialError(OAUTH_ACCOUNT_CHANGED_ERROR);
            throw new Error(OAUTH_ACCOUNT_CHANGED_ERROR);
          }
          await this.persistOAuth?.(next);
        }
        this.credential = next;
      }
      return this.credential;
    });
    this.chain = operation.catch(() => undefined);
    return operation;
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    if (providerId !== this.providerId) return Promise.resolve();
    const previous = this.chain;
    const operation = previous.then(() => {
      options?.signal?.throwIfAborted();
      this.credential = undefined;
    });
    this.chain = operation.catch(() => undefined);
    return operation;
  }
}
