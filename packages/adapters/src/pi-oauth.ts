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

export type PiOAuthComplete =
  | { status: "pending" }
  | {
      status: "connected";
      credential: OAuthCredential;
      provider: string;
      modelId?: string;
      label?: string;
    }
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

type Session = {
  id: string;
  userId: string;
  workspaceId: string;
  provider: string;
  modelId?: string;
  label?: string;
  abort: AbortController;
  credential?: OAuthCredential;
  error?: string;
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

  constructor(private readonly loginFn: LoginFn = defaultLogin) {}

  async begin(input: {
    userId: string;
    workspaceId: string;
    provider: string;
    modelId?: string;
    label?: string;
  }): Promise<PiOAuthBegin> {
    if (!isDeviceCodeProvider(input.provider)) {
      throw new Error(
        "In-app subscription sign-in is only available for ChatGPT Plus/Pro, GitHub Copilot, and SuperGrok.",
      );
    }
    this.abortForUserProvider(input.userId, input.provider);

    const abort = new AbortController();
    const loginId = randomUUID();
    const session: Session = {
      id: loginId,
      userId: input.userId,
      workspaceId: input.workspaceId,
      provider: input.provider,
      modelId: input.modelId,
      label: input.label,
      abort,
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
        return credential;
      })
      .catch((error) => {
        session.error = error instanceof Error ? error.message : "Subscription sign-in failed.";
        device.reject(error instanceof Error ? error : new Error(session.error));
        throw error;
      });

    void done.catch(() => undefined);
    this.pending.set(loginId, session);

    try {
      const started = await Promise.race([
        device.promise,
        sleep(DEVICE_CODE_WAIT_MS).then(() => {
          throw new Error("Subscription sign-in did not start. Try again.");
        }),
      ]);
      return {
        loginId,
        provider: input.provider,
        verificationUri: started.verificationUri,
        userCode: started.userCode,
        expiresInSeconds: started.expiresInSeconds,
      };
    } catch (error) {
      abort.abort();
      this.pending.delete(loginId);
      throw error;
    }
  }

  async complete(
    loginId: string,
    actor: { userId: string; workspaceId: string },
  ): Promise<PiOAuthComplete> {
    const session = this.pending.get(loginId);
    if (!session || session.userId !== actor.userId || session.workspaceId !== actor.workspaceId) {
      return { status: "error", error: "Sign-in session not found. Start sign-in again." };
    }
    if (session.error) {
      this.pending.delete(loginId);
      return { status: "error", error: session.error };
    }
    if (session.credential) {
      return {
        status: "connected",
        credential: session.credential,
        provider: session.provider,
        modelId: session.modelId,
        label: session.label,
      };
    }
    return { status: "pending" };
  }

  consume(loginId: string): void {
    const session = this.pending.get(loginId);
    session?.abort.abort();
    this.pending.delete(loginId);
  }

  abortAll(): void {
    for (const session of this.pending.values()) session.abort.abort();
    this.pending.clear();
  }

  private abortForUserProvider(userId: string, provider: string): void {
    for (const [id, session] of this.pending) {
      if (session.userId === userId && session.provider === provider) {
        session.abort.abort();
        this.pending.delete(id);
      }
    }
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
