import { randomUUID } from "node:crypto";
import type {
  AuthInteraction,
  Credential,
  OAuthAuth,
  OAuthCredential,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

export const CHATGPT_OAUTH_PROVIDER = "openai-codex";
export const COPILOT_OAUTH_PROVIDER = "github-copilot";
export const XAI_OAUTH_PROVIDER = "xai";
export const DEVICE_CODE_SIGN_IN = "device-code" as const;

export const DEVICE_CODE_PROVIDERS: Record<
  string,
  { loginLabel: string; hint: string; billing: string }
> = {
  [CHATGPT_OAUTH_PROVIDER]: {
    loginLabel: "Sign in with ChatGPT Plus/Pro",
    hint: "ChatGPT Plus/Pro",
    billing:
      "Sign in with ChatGPT Plus or Pro. Uses your OpenAI subscription. Rakazo does not pay.",
  },
  [COPILOT_OAUTH_PROVIDER]: {
    loginLabel: "Sign in with GitHub Copilot",
    hint: "Copilot",
    billing: "Sign in with GitHub Copilot. Uses your Copilot subscription. Rakazo does not pay.",
  },
  [XAI_OAUTH_PROVIDER]: {
    loginLabel: "Sign in with SuperGrok or X Premium",
    hint: "SuperGrok / key",
    billing: "Sign in with SuperGrok or X Premium, or paste an xAI API key. Rakazo does not pay.",
  },
};

export function isDeviceCodeProvider(providerId: string): boolean {
  return providerId in DEVICE_CODE_PROVIDERS;
}

const MIN_OAUTH_VALIDITY_MS = 5 * 60 * 1000;
const DEVICE_CODE_WAIT_MS = 30_000;

export type StoredModelSecret =
  | { kind: "api_key"; key: string }
  | { kind: "oauth"; credential: OAuthCredential };

export type PiOAuthConnected = {
  status: "connected";
  credential: OAuthCredential;
  provider: string;
  modelId?: string;
  label?: string;
  signal: AbortSignal;
};

export type PiOAuthComplete =
  | { status: "pending" }
  | PiOAuthConnected
  | { status: "error"; error: string };

export type PiOAuthFinish<T> =
  | { status: "pending" }
  | { status: "connected"; value: T }
  | { status: "error"; error: string };

export type PiOAuthBegin = {
  loginId: string;
  provider: string;
  verificationUri: string;
  userCode: string;
  expiresInSeconds: number;
};

type LoginFn = (
  providerId: string,
  type: "oauth",
  interaction: AuthInteraction,
) => Promise<Credential>;

type SessionState = "pending" | "ready" | "finalizing" | "consumed";

type Session = {
  id: string;
  scope: string;
  userId: string;
  workspaceId: string;
  provider: string;
  modelId?: string;
  label?: string;
  abort: AbortController;
  state: SessionState;
  credential?: OAuthCredential;
  error?: string;
  finishing?: Promise<void>;
};

function isOAuthCredential(value: Credential): value is OAuthCredential {
  return value.type === "oauth";
}

export function parseModelSecret(plaintext: string): StoredModelSecret {
  const trimmed = plaintext.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Partial<OAuthCredential>;
      if (
        parsed.type === "oauth" &&
        typeof parsed.access === "string" &&
        typeof parsed.refresh === "string" &&
        typeof parsed.expires === "number"
      ) {
        return { kind: "oauth", credential: parsed as OAuthCredential };
      }
    } catch {
      // Treat malformed JSON as a literal API key.
    }
  }
  return { kind: "api_key", key: plaintext };
}

export function serializeModelSecret(secret: StoredModelSecret): string {
  return secret.kind === "oauth" ? JSON.stringify(secret.credential) : secret.key;
}

export function secretValuesToRedact(secret: StoredModelSecret): string[] {
  if (secret.kind === "api_key") return secret.key ? [secret.key] : [];
  return [secret.credential.access, secret.credential.refresh].filter(Boolean);
}

export function loadProviderOAuth(providerId: string): OAuthAuth | undefined {
  return providerCatalog().getProvider(providerId)?.auth.oauth;
}

let cachedProviderCatalog: ReturnType<typeof builtinModels> | undefined;

function providerCatalog() {
  cachedProviderCatalog ??= builtinModels();
  return cachedProviderCatalog;
}

type ResolveModelOpts = {
  persist?: (next: string) => Promise<void>;
  now?: number;
  oauth?: Pick<OAuthAuth, "refresh" | "toAuth">;
  signal?: AbortSignal;
};

export async function resolveModelAuth(
  plaintext: string,
  provider: string,
  opts?: ResolveModelOpts,
): Promise<{ secret: StoredModelSecret; apiKey: string }> {
  const parsed = parseModelSecret(plaintext);
  if (parsed.kind === "api_key") return { secret: parsed, apiKey: parsed.key };
  const oauth = opts?.oauth ?? loadProviderOAuth(provider);
  if (!oauth) {
    throw new Error(`No OAuth handler for ${provider}. Sign in again from onboarding.`);
  }
  const now = opts?.now ?? Date.now();
  let credential = parsed.credential;
  if (credential.expires - now < MIN_OAUTH_VALIDITY_MS) {
    credential = await oauth.refresh(credential, opts?.signal ?? new AbortController().signal);
    await opts?.persist?.(serializeModelSecret({ kind: "oauth", credential }));
  }
  const auth = await oauth.toAuth(credential);
  if (!auth.apiKey) {
    throw new Error("Subscription sign-in did not produce a usable token. Sign in again.");
  }
  return { secret: { kind: "oauth", credential }, apiKey: auth.apiKey };
}

export async function resolveModelApiKey(
  plaintext: string,
  provider: string,
  opts?: ResolveModelOpts,
): Promise<string> {
  const resolved = await resolveModelAuth(plaintext, provider, opts);
  return resolved.apiKey;
}

export class PiOAuthLogins {
  private readonly pending = new Map<string, Session>();
  private readonly activeByScope = new Map<string, Session>();
  private readonly replacementTails = new Map<string, Promise<void>>();

  constructor(private readonly loginFn: LoginFn = defaultLogin) {}

  async begin(input: {
    userId: string;
    workspaceId: string;
    provider: string;
    modelId?: string;
    label?: string;
    signal?: AbortSignal;
  }): Promise<PiOAuthBegin> {
    if (!isDeviceCodeProvider(input.provider)) {
      throw new Error(
        "In-app subscription sign-in is only available for ChatGPT Plus/Pro, GitHub Copilot, and SuperGrok.",
      );
    }
    if (input.signal?.aborted) {
      throw input.signal.reason ?? new Error("Sign-in cancelled.");
    }

    const scope = oauthScopeKey(input.userId, input.workspaceId, input.provider);
    const prepared = await this.withReplacementLock(scope, input.signal, async () => {
      await this.retireActiveSession(scope, input.signal);
      throwIfAborted(input.signal);

      const abort = new AbortController();
      const abortFromRequest = () => abort.abort(input.signal?.reason);
      const loginId = randomUUID();
      const session: Session = {
        id: loginId,
        scope,
        userId: input.userId,
        workspaceId: input.workspaceId,
        provider: input.provider,
        modelId: input.modelId,
        label: input.label,
        abort,
        state: "pending",
      };

      const device = deferred<{
        userCode: string;
        verificationUri: string;
        expiresInSeconds: number;
      }>();

      const done = this.loginFn(input.provider, "oauth", {
        signal: abort.signal,
        async prompt(prompt) {
          if (prompt.type === "select") {
            const option = prompt.options.find((entry) => entry.id === "device_code");
            if (!option) {
              throw new Error("Device-code sign-in is not available for this provider.");
            }
            return option.id;
          }
          // Copilot asks for a GitHub Enterprise host first. Blank is github.com.
          if (prompt.type === "text") return "";
          throw new Error("Unexpected subscription login prompt.");
        },
        notify(event) {
          if (event.type === "device_code") {
            device.resolve({
              userCode: event.userCode,
              verificationUri: event.verificationUri,
              expiresInSeconds: event.expiresInSeconds ?? 15 * 60,
            });
          }
        },
      })
        .then((credential) => {
          if (!isOAuthCredential(credential)) {
            throw new Error("Subscription sign-in did not return an OAuth credential.");
          }
          session.credential = credential;
          session.state = "ready";
          return credential;
        })
        .catch((error) => {
          session.error = error instanceof Error ? error.message : "Subscription sign-in failed.";
          device.reject(error instanceof Error ? error : new Error(session.error));
          throw error;
        });

      if (input.signal?.aborted) abortFromRequest();
      else input.signal?.addEventListener("abort", abortFromRequest, { once: true });
      void done.catch(() => undefined);
      this.pending.set(loginId, session);
      this.activeByScope.set(scope, session);
      return { abort, abortFromRequest, device: device.promise, loginId, session };
    });

    const { abort, abortFromRequest, device, loginId, session } = prepared;

    try {
      const started = await Promise.race([
        device,
        sleep(DEVICE_CODE_WAIT_MS).then(() => {
          throw new Error("Subscription sign-in did not start. Try again.");
        }),
      ]);
      input.signal?.removeEventListener("abort", abortFromRequest);
      if (abort.signal.aborted) throw abort.signal.reason ?? new Error("Sign-in cancelled.");
      return {
        loginId,
        provider: input.provider,
        verificationUri: started.verificationUri,
        userCode: started.userCode,
        expiresInSeconds: started.expiresInSeconds,
      };
    } catch (error) {
      input.signal?.removeEventListener("abort", abortFromRequest);
      abort.abort();
      this.removeSession(session);
      throw error;
    }
  }

  complete(loginId: string, actor: { userId: string; workspaceId: string }): PiOAuthComplete {
    const session = this.pending.get(loginId);
    if (!session || session.userId !== actor.userId || session.workspaceId !== actor.workspaceId) {
      return { status: "error", error: "Sign-in session not found. Start sign-in again." };
    }
    if (session.error) {
      this.removeSession(session);
      return { status: "error", error: session.error };
    }
    if (session.state === "finalizing") return { status: "pending" };
    if (session.credential) {
      return {
        status: "connected",
        credential: session.credential,
        provider: session.provider,
        modelId: session.modelId,
        label: session.label,
        signal: session.abort.signal,
      };
    }
    return { status: "pending" };
  }

  async finish<T>(
    loginId: string,
    actor: { userId: string; workspaceId: string },
    persist: (result: PiOAuthConnected) => Promise<T>,
  ): Promise<PiOAuthFinish<T>> {
    const session = this.pending.get(loginId);
    if (!session || session.userId !== actor.userId || session.workspaceId !== actor.workspaceId) {
      return { status: "error", error: "Sign-in session not found. Start sign-in again." };
    }
    if (session.state === "finalizing") return { status: "pending" };
    const result = this.complete(loginId, actor);
    if (result.status !== "connected") return result;

    // The state transition is synchronous, so cancel either wins before this claim or waits for
    // the finalization to settle. The finalization signal is intentionally detached from cancel.
    const finishing = deferred<void>();
    session.finishing = finishing.promise;
    session.state = "finalizing";
    try {
      const value = await persist({ ...result, signal: new AbortController().signal });
      session.state = "consumed";
      this.removeSession(session);
      session.abort.abort();
      return { status: "connected", value };
    } catch (error) {
      if (this.pending.get(loginId) === session) session.state = "ready";
      throw error;
    } finally {
      if (this.pending.get(loginId) === session) session.finishing = undefined;
      finishing.resolve(undefined);
    }
  }

  async cancel(loginId: string, actor: { userId: string; workspaceId: string }): Promise<void> {
    while (true) {
      const session = this.pending.get(loginId);
      if (
        !session ||
        session.userId !== actor.userId ||
        session.workspaceId !== actor.workspaceId
      ) {
        return;
      }
      if (session.state === "finalizing") {
        if (session.finishing) await session.finishing;
        else return;
        continue;
      }
      if (session.state === "consumed") return;
      session.abort.abort(new Error("Sign-in cancelled."));
      this.removeSession(session);
      return;
    }
  }

  private async withReplacementLock<T>(
    scope: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.replacementTails.get(scope) ?? Promise.resolve();
    const release = deferred<void>();
    const current = previous.then(() => release.promise);
    this.replacementTails.set(scope, current);

    try {
      await previous;
      throwIfAborted(signal);
      return await operation();
    } finally {
      release.resolve(undefined);
      if (this.replacementTails.get(scope) === current) this.replacementTails.delete(scope);
    }
  }

  private async retireActiveSession(scope: string, signal: AbortSignal | undefined): Promise<void> {
    while (true) {
      throwIfAborted(signal);
      const session = this.activeByScope.get(scope);
      if (!session) return;
      if (session.state === "finalizing") {
        if (!session.finishing) {
          throw new Error("OAuth session is finalizing without a completion promise.");
        }
        await session.finishing;
        throwIfAborted(signal);
        continue;
      }
      if (session.state === "consumed") {
        this.removeSession(session);
        continue;
      }
      session.abort.abort(new Error("Sign-in replaced."));
      this.removeSession(session);
      return;
    }
  }

  private removeSession(session: Session): void {
    if (this.pending.get(session.id) === session) this.pending.delete(session.id);
    if (this.activeByScope.get(session.scope) === session) {
      this.activeByScope.delete(session.scope);
    }
  }

  abortAll(): void {
    for (const session of this.pending.values()) session.abort.abort();
    this.pending.clear();
    this.activeByScope.clear();
  }
}

function defaultLogin(
  providerId: string,
  type: "oauth",
  interaction: AuthInteraction,
): Promise<Credential> {
  return builtinModels().login(providerId, type, interaction);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function oauthScopeKey(userId: string, workspaceId: string, provider: string): string {
  return JSON.stringify([userId, workspaceId, provider]);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Sign-in cancelled.");
}
