import { randomBytes, randomUUID } from "node:crypto";
import type { AuthInteraction, Credential, OAuthCredential } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { SecretStore } from "@rakazo/adapter-kit";
import type { ModelOAuthBegin, ModelSignInCancelReason, SettingsScope } from "@rakazo/contracts";
import type { Prisma, PrismaClient } from "@rakazo/db";
import { runAsSystem, runAsTenant } from "@rakazo/db";
import { getLogger } from "@rakazo/logging";
import { ModelProviderNotAllowedError } from "../../../models/model-provider-allowlist.js";
import type { ModelProviderDefinition } from "../../../models/model-provider-registry.js";
import { modelProviders } from "../../../models/model-provider-registry.js";
import { logModelSignIn } from "./model-sign-in-log.js";
import { createManualAnthropicOAuthLogin } from "./pi-anthropic-oauth.js";
import type { PiOAuthEnd, PiOAuthEnded, PiOAuthMeasure, PiOAuthPending } from "./pi-oauth-ended.js";
import { PENDING_SIGN_IN_COLUMNS, pendingSignInOfRow, signInFailure } from "./pi-oauth-ended.js";

export const CHATGPT_OAUTH_PROVIDER = "openai-codex";
export const COPILOT_OAUTH_PROVIDER = "github-copilot";
export const XAI_OAUTH_PROVIDER = "xai";
export const ANTHROPIC_OAUTH_PROVIDER = "anthropic";

/** Providers Rakazo offers a subscription sign-in for, by id. */
export const SUBSCRIPTION_SIGN_IN_PROVIDERS = Object.fromEntries(
  Object.entries(modelProviders as Record<string, ModelProviderDefinition>).flatMap(
    ([id, { signIn }]) => (signIn ? [[id, signIn]] : []),
  ),
) as Record<string, NonNullable<ModelProviderDefinition["signIn"]>>;

const SIGN_IN_START_WAIT_MS = 30_000;
/** How long a sign-in that hands back a code stays open, on any API process. */
const PASTED_CODE_TTL_SECONDS = 15 * 60;
/** Outcomes outlive the longest provider code, so a slow client can still read one. */
const SIGN_IN_ROW_RETENTION_MS = 60 * 60 * 1000;
/** A sign-in whose process stops renewing this long is reported as interrupted. */
const SIGN_IN_LEASE_MS = 30_000;
export const SIGN_IN_LEASE_RENEW_MS = 10_000;
const SAVE_WAIT_POLL_MS = 250;
const OUTCOME_WRITE_ATTEMPTS = 3;
const SIGN_IN_NOT_FOUND = "Sign-in session not found. Start sign-in again.";
const SIGN_IN_INTERRUPTED = "Sign-in was interrupted. Start sign-in again.";
const SIGN_IN_SAVE_FAILED = "Could not save the sign-in. Try again.";

export type { ResolveModelOpts, RetireModelCredential } from "./model-auth-resolution.js";
export {
  codexComputeResidency,
  isRetiredModelCredentialError,
  loadProviderOAuth,
  MIN_OAUTH_VALIDITY_MS,
  matchesFailedOAuthSecret,
  OAUTH_ACCOUNT_CHANGED_ERROR,
  OAUTH_RECONNECT_REQUIRED_ERROR,
  oauthAccountChange,
  oauthCredentialAccountId,
  oauthCredentialEmail,
  RetiredModelCredentialError,
  resolveModelApiKey,
  resolveModelAuth,
  terminalOAuthRefreshErrorMarker,
  tryRetireModelCredential,
} from "./model-auth-resolution.js";

export type PiOAuthConnected = {
  credential: OAuthCredential;
  provider: string;
  /** The connection this sign-in renews; null adds one; undefined is an older app's sign-in. */
  credentialId?: string | null;
  modelId?: string;
  thinkingLevel?: string | null;
  makeDefault?: boolean;
  /** Which copy of the member's models makeDefault sets; omitted means the one that applies. */
  settingsScope?: SettingsScope;
  label?: string;
  mode?: PiOAuthPending["mode"];
  startedAt?: Date;
  measure?: PiOAuthMeasure;
  signal: AbortSignal;
};

/** Saves a finished sign-in's credential where connections are kept. It runs on the API
 *  process that holds the provider exchange, after the request that started it has ended. */
export type PiOAuthPersist<T> = (login: PiOAuthConnected) => Promise<T>;

export type PiOAuthComplete =
  | { status: "pending" }
  | { status: "connected"; provider: string }
  /** The provider is known once a session existed, so the failure can be attributed. */
  | { status: "error"; error: string; provider?: string };

export type PiOAuthFinish<T> =
  | { status: "pending" }
  | { status: "connected"; value: T; provider: string }
  | { status: "error"; error: string; provider?: string };

export type PiOAuthBegin = ModelOAuthBegin;

type WithoutLogin<T> = T extends unknown ? Omit<T, "loginId" | "provider"> : never;
type PiOAuthStarted = WithoutLogin<PiOAuthBegin>;

type LoginFn = (
  providerId: string,
  type: "oauth",
  interaction: AuthInteraction,
  options?: { codePage?: boolean; verifier?: string },
) => Promise<Credential>;

/** A pasted-code sign-in the user has to correct or start again. */
export class ModelSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelSignInError";
  }
}

type SignInActor = { userId: string; spaceId: string };

type BeginInput<T> = SignInActor & {
  provider: string;
  persist: PiOAuthPersist<T>;
  credentialId?: string | null;
  modelId?: string;
  thinkingLevel?: string | null;
  makeDefault?: boolean;
  settingsScope?: SettingsScope;
  label?: string;
  /** The client has no loopback listener, so the provider shows the code to paste. */
  codePage?: boolean;
  measure?: PiOAuthMeasure;
  signal?: AbortSignal;
};

/** What another API process needs to finish a sign-in that hands back a code. */
type HandedOffSignIn = Omit<
  BeginInput<unknown>,
  "userId" | "spaceId" | "signal" | "persist" | "measure"
> & {
  verifier: string;
};

/** Where sign-ins and their outcomes are kept, so any API process can report, finish or
 *  cancel one, and a pasted code can be exchanged by whichever process receives it.
 *  Without it sign-ins live in this process only. */
export type PiOAuthHandoffStore = {
  prisma: Pick<PrismaClient, "modelOAuthSession">;
  secrets: Pick<SecretStore, "put" | "load">;
};

type SessionState = "pending" | "finalizing" | "connected" | "failed";

type Session<T> = {
  id: string;
  scope: string;
  userId: string;
  spaceId: string;
  provider: string;
  credentialId?: string | null;
  modelId?: string;
  thinkingLevel?: string | null;
  makeDefault?: boolean;
  settingsScope?: SettingsScope;
  label?: string;
  /** Set once the provider gave a link or code. */
  mode?: PiOAuthPending["mode"];
  startedAt: Date;
  measure?: PiOAuthMeasure;
  persist: PiOAuthPersist<T>;
  abort: AbortController;
  state: SessionState;
  result?: T;
  error?: string;
  /** Resolves once begin or resume has stored the sign-in's row, or found it cannot. */
  setup: ReturnType<typeof deferred<void>>;
  finishing?: Promise<void>;
  // auth-url flows: resolves the runtime's "paste the redirect URL" prompt.
  submitCode?: (input: string) => void;
  codeSubmitted?: boolean;
  /** A row in the store holds this sign-in. */
  stored?: boolean;
  /** This process exchanges with the provider and renews the row's lease. */
  lease?: ReturnType<typeof setInterval>;
  expiresTimer?: ReturnType<typeof setTimeout>;
  /** The expiry timer fired while the credential was being saved. */
  expired?: boolean;
  /** Why it was stopped, for a row stored only after that. */
  stoppedAs?: PiOAuthEnd["reason"];
};

type Outcome<T> =
  | { status: "pending" }
  | { status: "connected"; provider: string; value: T }
  | { status: "failed"; provider: string; error: string };

type RowRef = Pick<Session<unknown>, "id" | "userId" | "spaceId">;

function isOAuthCredential(value: Credential): value is OAuthCredential {
  return value.type === "oauth";
}

export class PiOAuthLogins<T = unknown> {
  private readonly pending = new Map<string, Session<T>>();
  private readonly activeByScope = new Map<string, Session<T>>();
  private readonly replacementTails = new Map<string, Promise<void>>();

  constructor(
    private readonly loginFn: LoginFn = defaultLogin,
    private readonly handoff?: PiOAuthHandoffStore,
    /** Told of each sign-in that gave the person a link or code and then did not connect. */
    private readonly onEnded?: (ended: PiOAuthEnded) => void,
  ) {}

  async begin(input: BeginInput<T>): Promise<PiOAuthBegin> {
    // The pasted code can reach another API process (a deploy replaces this one), which
    // then needs this verifier to exchange it.
    const verifier =
      this.handoff && SUBSCRIPTION_SIGN_IN_PROVIDERS[input.provider]?.mode === "auth-url"
        ? randomBytes(32).toString("base64url")
        : undefined;
    const started = await this.start(input, randomUUID(), verifier);
    const session = this.pending.get(started.loginId);
    if (!session) return started;
    try {
      await this.store(session, input, started.mode, verifier);
      if (this.pending.get(session.id) === session) logModelSignIn(session, "authorization_ready");
    } catch (error) {
      logModelSignIn(session, "storage_failed");
      session.abort.abort();
      this.detachSession(session);
      throw error;
    } finally {
      session.setup.resolve();
    }
    return started;
  }

  private async start(
    input: BeginInput<T>,
    loginId: string,
    verifier: string | undefined,
    /** When the link was issued, for a sign-in another process began. */
    issuedAt?: Date,
  ): Promise<PiOAuthBegin> {
    if (!SUBSCRIPTION_SIGN_IN_PROVIDERS[input.provider]) {
      throw new Error(
        "In-app subscription sign-in is only available for ChatGPT Plus/Pro, Claude Pro/Max, GitHub Copilot, and SuperGrok.",
      );
    }
    if (input.signal?.aborted) {
      throw input.signal.reason ?? new Error("Sign-in cancelled.");
    }

    const scope = oauthScopeKey(input.userId, input.spaceId, input.provider, input.credentialId);
    const lockKey = oauthProviderKey(input.userId, input.provider);
    const prepared = await this.withReplacementLock(lockKey, input.signal, async () => {
      await this.retireActiveSession(scope, input.signal, "replacement");
      throwIfAborted(input.signal);

      const abort = new AbortController();
      const abortFromRequest = () => abort.abort(input.signal?.reason);
      const session: Session<T> = {
        id: loginId,
        scope,
        userId: input.userId,
        spaceId: input.spaceId,
        provider: input.provider,
        credentialId: input.credentialId,
        modelId: input.modelId,
        thinkingLevel: input.thinkingLevel,
        makeDefault: input.makeDefault,
        settingsScope: input.settingsScope,
        label: input.label,
        startedAt: issuedAt ?? new Date(),
        measure: input.measure,
        persist: input.persist,
        abort,
        state: "pending",
        setup: deferred<void>(),
      };

      logModelSignIn(session, issuedAt ? "resumed" : "started");
      const signInStarted = deferred<PiOAuthStarted>();

      const done = this.loginFn(
        input.provider,
        "oauth",
        {
          signal: abort.signal,
          async prompt(prompt) {
            if (prompt.type === "select") {
              const option = prompt.options.find((entry) => entry.id === "device_code");
              if (!option) {
                throw new Error("Device-code sign-in is not available for this provider.");
              }
              return option.id;
            }
            if (prompt.type === "manual_code") {
              return new Promise<string>((resolve, reject) => {
                const signals = [abort.signal, prompt.signal].filter(
                  (signal): signal is AbortSignal => signal !== undefined,
                );
                const removeAbortListeners = () => {
                  for (const signal of signals) signal.removeEventListener("abort", onAbort);
                };
                const onAbort = (event: Event) => {
                  removeAbortListeners();
                  session.submitCode = undefined;
                  const signal = event.currentTarget as AbortSignal;
                  reject(signal.reason ?? new Error("Sign-in cancelled."));
                };
                session.submitCode = (code) => {
                  removeAbortListeners();
                  session.submitCode = undefined;
                  resolve(code);
                };
                const aborted = signals.find((signal) => signal.aborted);
                if (aborted) {
                  removeAbortListeners();
                  session.submitCode = undefined;
                  reject(aborted.reason ?? new Error("Sign-in cancelled."));
                } else {
                  for (const signal of signals)
                    signal.addEventListener("abort", onAbort, { once: true });
                }
              });
            }
            // Copilot asks for a GitHub Enterprise host first. Blank is github.com.
            if (prompt.type === "text") return "";
            throw new Error("Unexpected subscription login prompt.");
          },
          notify(event) {
            if (event.type === "device_code") {
              session.mode = "device-code";
              session.startedAt = issuedAt ?? new Date();
              signInStarted.resolve({
                mode: "device-code",
                userCode: event.userCode,
                verificationUri: httpsAuthorizationUrl(event.verificationUri),
                expiresInSeconds: event.expiresInSeconds ?? 15 * 60,
              });
            }
            if (event.type === "auth_url") {
              session.mode = "auth-url";
              session.startedAt = issuedAt ?? new Date();
              signInStarted.resolve({
                mode: "auth-url",
                verificationUri: httpsAuthorizationUrl(event.url),
                expiresInSeconds: PASTED_CODE_TTL_SECONDS,
              });
            }
          },
        },
        { codePage: input.codePage, verifier },
      ).then(
        (credential) => {
          if (!isOAuthCredential(credential)) {
            throw new Error("Subscription sign-in did not return an OAuth credential.");
          }
          void this.finalize(session, credential);
        },
        (error: unknown) => {
          const message = error instanceof Error ? error.message : "Subscription sign-in failed.";
          signInStarted.reject(error instanceof Error ? error : new Error(message));
          // Cancelled, replaced or shut down: whoever stopped it has dealt with the outcome.
          if (!abort.signal.aborted) void this.fail(session, message);
        },
      );

      if (input.signal?.aborted) abortFromRequest();
      else
        input.signal?.addEventListener("abort", abortFromRequest, {
          once: true,
        });
      void done.catch((error: unknown) =>
        this.fail(session, error instanceof Error ? error.message : "Subscription sign-in failed."),
      );
      this.pending.set(loginId, session);
      this.activeByScope.set(scope, session);
      return {
        abort,
        abortFromRequest,
        signInStarted: signInStarted.promise,
        session,
      };
    });

    const { abort, abortFromRequest, signInStarted, session } = prepared;
    const startTimeout = new Error("Subscription sign-in did not start. Try again.");

    try {
      const started = await Promise.race([
        signInStarted,
        sleep(SIGN_IN_START_WAIT_MS).then(() => {
          throw startTimeout;
        }),
      ]);
      input.signal?.removeEventListener("abort", abortFromRequest);
      if (abort.signal.aborted) throw abort.signal.reason ?? new Error("Sign-in cancelled.");
      session.expiresTimer = setTimeout(() => {
        // Removing a finalizing session would free the scope for a replacement login
        // whose credential the in-flight save could overwrite. Remember the expiry so
        // the session is dropped once the save settles.
        if (session.state === "finalizing") {
          session.expired = true;
          return;
        }
        session.abort.abort(new Error("Sign-in expired."));
        // A stored outcome stays for whichever process the client asks next.
        if (session.state === "pending") this.removeSession(session, "timed_out");
        else this.detachSession(session);
      }, started.expiresInSeconds * 1000);
      session.expiresTimer.unref?.();
      return {
        loginId,
        provider: input.provider,
        ...started,
      };
    } catch (error) {
      logModelSignIn(
        session,
        "start_failed",
        abort.signal.aborted
          ? { reason: "cancelled" }
          : error === startTimeout
            ? { reason: "timed_out" }
            : signInFailure(error instanceof Error ? error.message : ""),
      );
      input.signal?.removeEventListener("abort", abortFromRequest);
      abort.abort();
      this.detachSession(session);
      session.setup.resolve();
      throw error;
    }
  }

  /** Stores a sign-in this process just began, so any process can report, finish or cancel it. */
  private async store(
    session: Session<T>,
    input: BeginInput<T>,
    mode: PiOAuthBegin["mode"],
    verifier: string | undefined,
  ): Promise<void> {
    const handoff = this.handoff;
    if (!handoff) return;
    const actor = { userId: session.userId, spaceId: session.spaceId };
    let ciphertext: string | null = null;
    if (verifier) {
      const stored: HandedOffSignIn = {
        provider: input.provider,
        credentialId: input.credentialId,
        modelId: input.modelId,
        thinkingLevel: input.thinkingLevel,
        makeDefault: input.makeDefault,
        settingsScope: input.settingsScope,
        label: input.label,
        codePage: input.codePage,
        verifier,
      };
      ciphertext = (
        await handoff.secrets.put(
          JSON.stringify(stored),
          {
            operationId: "model.oauth.session",
            traceId: "model.oauth.session",
            ...actor,
            signal: new AbortController().signal,
          },
          { recordId: session.id, ephemeral: true },
        )
      ).ciphertext;
    }
    await runAsSystem("expire abandoned model sign-ins in every Space", () =>
      handoff.prisma.modelOAuthSession.deleteMany({
        where: { createdAt: { lt: new Date(Date.now() - SIGN_IN_ROW_RETENTION_MS) } },
      }),
    );
    await runAsTenant(actor, async () => {
      const created = await handoff.prisma.modelOAuthSession.create({
        data: {
          id: session.id,
          ...actor,
          provider: session.provider,
          scope: session.scope,
          ciphertext,
          // A pasted-code sign-in has no owner until a process receives its code.
          leaseExpiresAt: mode === "device-code" ? leaseEnd() : null,
          surface: session.measure?.surface ?? null,
          connectNumber: session.measure?.attempt ?? null,
        },
        select: { createdAt: true },
      });
      // This sign-in replaces older ones for the same connection left open elsewhere, so
      // an older code cannot come back and retire it. A newer one is never touched.
      const older = { ...actor, scope: session.scope, createdAt: { lt: created.createdAt } };
      await this.endRows(older, "replaced");
      await handoff.prisma.modelOAuthSession.deleteMany({
        where: { ...older, status: { not: "saving" } },
      });
    });
    session.stored = true;
    if (mode === "device-code") this.holdLease(session);
    // Cancelled, replaced or disconnected while saving: no process may resume it.
    if (this.pending.get(session.id) !== session) {
      await this.forgetRow(session, { ended: session.stoppedAs ?? "cancelled" });
    }
  }

  async submit(
    loginId: string,
    actor: SignInActor,
    code: string,
    persist: PiOAuthPersist<T>,
  ): Promise<{ ok: true }> {
    const normalizedCode = code.trim();
    let session = this.ownSession(loginId, actor);
    if (!session && normalizedCode) session = await this.resume(loginId, actor, persist);
    if (!session) throw new ModelSignInError(SIGN_IN_NOT_FOUND);
    if (session.error) throw new ModelSignInError(session.error);
    if (!normalizedCode) throw new ModelSignInError("Paste an authorization code or callback URL.");
    const resolve = session.submitCode;
    if (session.codeSubmitted) return { ok: true };
    if (!resolve) {
      throw new ModelSignInError("This sign-in is not waiting for a pasted code.");
    }
    session.codeSubmitted = true;
    // The code is in: this process owns the exchange, and no other may resume it.
    if (session.stored && !session.lease && !(await this.claim(session))) {
      // Another process took the code first, or the sign-in was cancelled there.
      session.abort.abort(new Error("Sign-in continued elsewhere."));
      this.detachSession(session);
      return { ok: true };
    }
    logModelSignIn(session, "code_submitted");
    resolve(normalizedCode);
    return { ok: true };
  }

  /** Take over a sign-in another API process started, once, within its lifetime. */
  private async resume(
    loginId: string,
    { userId, spaceId }: SignInActor,
    persist: PiOAuthPersist<T>,
  ): Promise<Session<T> | undefined> {
    const handoff = this.handoff;
    if (!handoff) return undefined;
    const ref = { id: loginId, userId, spaceId };
    const row = await runAsTenant({ userId, spaceId }, () =>
      handoff.prisma.modelOAuthSession.findFirst({
        where: { ...unclaimedRow(ref), createdAt: { gte: pastedCodeCutoff() } },
        select: PENDING_SIGN_IN_COLUMNS,
      }),
    );
    if (!row?.ciphertext) return undefined;
    const pending = pendingSignInOfRow(row);
    let stored: HandedOffSignIn | null;
    try {
      stored = JSON.parse(await handoff.secrets.load(row.ciphertext, loginId)) as HandedOffSignIn;
    } catch (error) {
      logModelSignIn({ ...pending, id: loginId }, "handoff_unreadable");
      getLogger().error("model sign-in hand-off unreadable", error, {
        "model.sign_in.id": loginId,
      });
      return undefined;
    }
    if (typeof stored?.verifier !== "string" || typeof stored.provider !== "string") {
      logModelSignIn({ ...pending, id: loginId }, "handoff_unreadable");
      return undefined;
    }
    if (!(await this.claim(ref, { createdAt: { gte: pastedCodeCutoff() } }))) return undefined;
    const { verifier, ...input } = stored;
    const { measure, startedAt } = pending;
    await this.start({ ...input, userId, spaceId, persist, measure }, loginId, verifier, startedAt);
    const session = this.pending.get(loginId);
    if (session) {
      session.stored = true;
      this.holdLease(session);
      session.setup.resolve();
    }
    return session;
  }

  /** Take the exchange of a pasted-code sign-in no process holds yet; false when one does. */
  private async claim(ref: RowRef, where: { createdAt?: { gte: Date } } = {}): Promise<boolean> {
    const handoff = this.handoff;
    if (!handoff) return true;
    const claimed = await runAsTenant({ userId: ref.userId, spaceId: ref.spaceId }, () =>
      handoff.prisma.modelOAuthSession.updateMany({
        where: { ...unclaimedRow(ref), ...where },
        data: { leaseExpiresAt: leaseEnd() },
      }),
    );
    if (claimed.count !== 1) return false;
    const session = this.pending.get(ref.id);
    if (session === ref) this.holdLease(session);
    return true;
  }

  /** Renew the row's lease while this process exchanges with the provider. */
  private holdLease(session: Session<T>): void {
    if (session.lease || !this.handoff) return;
    session.lease = setInterval(() => void this.renewLease(session), SIGN_IN_LEASE_RENEW_MS);
    session.lease.unref?.();
  }

  private releaseLease(session: Session<T>): void {
    if (session.lease) clearInterval(session.lease);
    session.lease = undefined;
  }

  private async renewLease(session: Session<T>): Promise<void> {
    const handoff = this.handoff;
    if (!handoff) return;
    try {
      const renewed = await runAsTenant({ userId: session.userId, spaceId: session.spaceId }, () =>
        handoff.prisma.modelOAuthSession.updateMany({
          where: { ...rowOf(session), status: { in: ["pending", "saving"] } },
          data: { leaseExpiresAt: leaseEnd() },
        }),
      );
      // Cancelled, replaced or disconnected on another process.
      if (renewed.count === 0 && session.state === "pending") {
        logModelSignIn(session, "handoff_lost");
        session.abort.abort(new Error("Sign-in cancelled."));
        this.detachSession(session);
      }
    } catch (error) {
      getLogger().error("model sign-in lease not renewed", error, {
        "model.sign_in.id": session.id,
      });
    }
  }

  private async finalize(session: Session<T>, credential: OAuthCredential): Promise<void> {
    await session.setup.promise;
    if (this.pending.get(session.id) !== session || session.state !== "pending") return;
    // The state transition is synchronous, so cancel either wins before this claim or waits
    // on `finishing` instead of aborting the save. Teardown aborts the session signal only
    // after the save settles.
    const finishing = deferred<void>();
    session.finishing = finishing.promise;
    session.state = "finalizing";
    logModelSignIn(session, "authorized");
    try {
      if (session.stored && !(await this.markSaving(session))) {
        logModelSignIn(session, "handoff_lost");
        session.abort.abort(new Error("Sign-in cancelled."));
        this.detachSession(session);
        return;
      }
      logModelSignIn(session, "saving");
      // The request that started the sign-in may be long gone; save as its member.
      const value = await runAsTenant({ userId: session.userId, spaceId: session.spaceId }, () =>
        session.persist({
          credential,
          provider: session.provider,
          credentialId: session.credentialId,
          modelId: session.modelId,
          thinkingLevel: session.thinkingLevel,
          makeDefault: session.makeDefault,
          settingsScope: session.settingsScope,
          label: session.label,
          mode: session.mode,
          startedAt: session.startedAt,
          measure: session.measure,
          signal: session.abort.signal,
        }),
      );
      session.result = value;
      session.state = "connected";
      if (
        await this.writeOutcome(session, {
          status: "connected",
          result: value as Prisma.InputJsonValue,
        })
      )
        logModelSignIn(session, "connected");
    } catch (error) {
      // A refusal the person can act on keeps its own words; anything else is a server fault.
      const refusal =
        error instanceof ModelSignInError || error instanceof ModelProviderNotAllowedError
          ? error
          : undefined;
      if (!refusal)
        getLogger().error("model sign-in not saved", error, { "model.sign_in.id": session.id });
      session.state = "failed";
      session.error = refusal ? refusal.message : SIGN_IN_SAVE_FAILED;
      if (await this.writeOutcome(session, { status: "failed", error: session.error })) {
        this.report(this.pendingOf(session), { reason: "save_failed" }, session.id);
      }
    } finally {
      this.releaseLease(session);
      session.finishing = undefined;
      finishing.resolve();
      if (session.expired) {
        session.abort.abort(new Error("Sign-in expired."));
        this.detachSession(session);
      }
    }
  }

  private async fail(session: Session<T>, message: string): Promise<void> {
    if (session.state !== "pending") return;
    session.state = "failed";
    session.error = message;
    this.releaseLease(session);
    await session.setup.promise;
    if (
      this.pending.get(session.id) === session &&
      (await this.writeOutcome(session, { status: "failed", error: message }))
    ) {
      this.report(this.pendingOf(session), signInFailure(message), session.id);
    }
  }

  private pendingOf(session: Session<T>): PiOAuthPending | undefined {
    const { userId, provider, mode, startedAt, measure } = session;
    return mode
      ? { userId, provider, mode, startedAt, ...(measure ? { measure } : {}) }
      : undefined;
  }

  /** Measurement never decides how a sign-in ends. */
  private report(pending: PiOAuthPending | undefined, end: PiOAuthEnd, loginId: string): void {
    if (!pending) return;
    logModelSignIn({ ...pending, id: loginId }, "ended", end);
    if (!this.onEnded) return;
    try {
      this.onEnded({ ...pending, ...end });
    } catch (error) {
      getLogger().error("model sign-in end not reported", error, { "model.sign_in.id": loginId });
    }
  }

  /**
   * Deletes stored sign-ins still waiting for the person and reports each as ended. The
   * delete decides which process reports one, so a sign-in another process already ended
   * stays silent here. Runs as the caller's tenant.
   */
  private async endRows(
    where: Prisma.ModelOAuthSessionWhereInput,
    reason: PiOAuthEnd["reason"],
    statuses: string[] = ["pending"],
  ): Promise<void> {
    const handoff = this.handoff;
    if (!handoff) return;
    const waiting = { ...where, status: { in: statuses } };
    const rows = await handoff.prisma.modelOAuthSession.findMany({
      where: waiting,
      select: PENDING_SIGN_IN_COLUMNS,
    });
    for (const row of rows) {
      const deleted = await handoff.prisma.modelOAuthSession.deleteMany({
        where: { ...waiting, id: row.id },
      });
      if (deleted.count === 1) this.report(pendingSignInOfRow(row), { reason }, row.id);
    }
  }

  /** A sign-in still waiting for the person, for a step only the app saw. */
  async pendingSignIn(loginId: string, actor: SignInActor): Promise<PiOAuthPending | undefined> {
    const session = this.ownSession(loginId, actor);
    if (session) return session.state === "pending" ? this.pendingOf(session) : undefined;
    const handoff = this.handoff;
    if (!handoff) return undefined;
    const ref = { id: loginId, userId: actor.userId, spaceId: actor.spaceId };
    const row = await runAsTenant(ref, () =>
      handoff.prisma.modelOAuthSession.findFirst({
        where: { ...rowOf(ref), status: "pending" },
        select: PENDING_SIGN_IN_COLUMNS,
      }),
    );
    return row ? pendingSignInOfRow(row) : undefined;
  }

  /** Take the right to save a credential; false when the sign-in was cancelled elsewhere. */
  private async markSaving(session: Session<T>): Promise<boolean> {
    const handoff = this.handoff;
    if (!handoff) return true;
    const marked = await runAsTenant({ userId: session.userId, spaceId: session.spaceId }, () =>
      handoff.prisma.modelOAuthSession.updateMany({
        where: { ...rowOf(session), status: "pending" },
        data: { status: "saving", leaseExpiresAt: leaseEnd() },
      }),
    );
    return marked.count === 1;
  }

  private async writeOutcome(
    session: Session<T>,
    outcome:
      | { status: "connected"; result: Prisma.InputJsonValue }
      | { status: "failed"; error: string },
    from?: "pending",
  ): Promise<boolean> {
    const handoff = this.handoff;
    if (!handoff) return true;
    if (!session.stored) return false;
    // A credential already saved must not read as interrupted over one failed write.
    for (let attempt = 1; ; attempt += 1) {
      try {
        const written = await runAsTenant(
          { userId: session.userId, spaceId: session.spaceId },
          () =>
            handoff.prisma.modelOAuthSession.updateMany({
              where: { ...rowOf(session), ...(from ? { status: from } : {}) },
              data: { ...outcome, leaseExpiresAt: null },
            }),
        );
        // No row: another process cancelled or replaced the sign-in, and reported that.
        if (written.count === 0) logModelSignIn(session, "handoff_lost");
        return written.count > 0;
      } catch (error) {
        if (attempt >= OUTCOME_WRITE_ATTEMPTS) {
          logModelSignIn(session, "storage_failed");
          getLogger().error("model sign-in outcome not stored", error, {
            "model.sign_in.id": session.id,
          });
          return false;
        }
        await sleep(SAVE_WAIT_POLL_MS * attempt);
      }
    }
  }

  async complete(loginId: string, actor: SignInActor): Promise<PiOAuthComplete> {
    const outcome = await this.outcome(loginId, actor);
    if (!outcome) return { status: "error", error: SIGN_IN_NOT_FOUND };
    if (outcome.status === "failed") {
      await this.forget(loginId, actor);
      const { error, provider } = outcome;
      return { status: "error", error, provider };
    }
    if (outcome.status === "connected") return { status: "connected", provider: outcome.provider };
    return { status: "pending" };
  }

  async finish(loginId: string, actor: SignInActor): Promise<PiOAuthFinish<T>> {
    const outcome = await this.outcome(loginId, actor);
    if (!outcome) return { status: "error", error: SIGN_IN_NOT_FOUND };
    if (outcome.status === "pending") return { status: "pending" };
    await this.forget(loginId, actor);
    return outcome.status === "connected"
      ? { status: "connected", value: outcome.value, provider: outcome.provider }
      : {
          status: "error",
          error: outcome.error,
          provider: outcome.provider,
        };
  }

  /** The stored row is the outcome when there is a store: another process may hold the sign-in. */
  private async outcome(loginId: string, actor: SignInActor): Promise<Outcome<T> | undefined> {
    const handoff = this.handoff;
    if (!handoff) {
      const session = this.ownSession(loginId, actor);
      if (!session) return undefined;
      if (session.state === "connected") {
        return { status: "connected", provider: session.provider, value: session.result as T };
      }
      if (session.state === "failed") {
        return {
          status: "failed",
          provider: session.provider,
          error: session.error ?? "Subscription sign-in failed.",
        };
      }
      return { status: "pending" };
    }
    const row = await runAsTenant({ userId: actor.userId, spaceId: actor.spaceId }, () =>
      handoff.prisma.modelOAuthSession.findFirst({
        where: rowOf({ id: loginId, ...actor }),
        select: {
          provider: true,
          status: true,
          error: true,
          result: true,
          leaseExpiresAt: true,
          createdAt: true,
        },
      }),
    );
    if (!row) return undefined;
    const { provider } = row;
    if (row.status === "connected") {
      return { status: "connected", provider, value: row.result as unknown as T };
    }
    if (row.status === "failed") {
      return {
        status: "failed",
        provider,
        error: row.error ?? "Subscription sign-in failed.",
      };
    }
    if (row.leaseExpiresAt) {
      return row.leaseExpiresAt.getTime() < Date.now()
        ? { status: "failed", provider, error: SIGN_IN_INTERRUPTED }
        : { status: "pending" };
    }
    // A pasted-code sign-in nobody finished in time is gone.
    return row.createdAt < pastedCodeCutoff() ? undefined : { status: "pending" };
  }

  /** Drop a sign-in whose outcome the client has read. */
  private async forget(loginId: string, actor: SignInActor): Promise<void> {
    const session = this.ownSession(loginId, actor);
    if (session) {
      session.abort.abort();
      this.detachSession(session);
    }
    const handoff = this.handoff;
    if (!handoff) return;
    await runAsTenant({ userId: actor.userId, spaceId: actor.spaceId }, async () => {
      // A row still waiting or saving here outlived the process that held it.
      await this.endRows(rowOf({ id: loginId, ...actor }), "interrupted", ["pending", "saving"]);
      await handoff.prisma.modelOAuthSession.deleteMany({
        where: rowOf({ id: loginId, ...actor }),
      });
    });
  }

  async cancel(
    loginId: string,
    actor: SignInActor,
    reason: ModelSignInCancelReason = "cancelled",
  ): Promise<void> {
    let waiting: PiOAuthPending | undefined;
    while (true) {
      const session = this.ownSession(loginId, actor);
      if (!session) break;
      if (session.state === "finalizing" && session.finishing) {
        await session.finishing;
        continue;
      }
      if (session.state === "pending") waiting = this.pendingOf(session);
      session.stoppedAs = reason;
      session.abort.abort(new Error("Sign-in cancelled."));
      this.detachSession(session);
      break;
    }
    const ref = { id: loginId, userId: actor.userId, spaceId: actor.spaceId };
    if (!this.handoff) this.report(waiting, { reason }, loginId);
    // Any process may hold it: that process sees its row go and stops. A save under way
    // finishes; the client has stopped asking for it.
    await this.forgetRow(ref, { ended: reason });
  }

  private ownSession(loginId: string, actor: SignInActor): Session<T> | undefined {
    const session = this.pending.get(loginId);
    return session && session.userId === actor.userId && session.spaceId === actor.spaceId
      ? session
      : undefined;
  }

  private async withReplacementLock<R>(
    scope: string,
    signal: AbortSignal | undefined,
    operation: () => Promise<R>,
  ): Promise<R> {
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

  private async retireActiveSession(
    scope: string,
    signal: AbortSignal | undefined,
    cause: "replacement" | "disconnect",
  ): Promise<void> {
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
      if (cause === "replacement" && session.state === "pending")
        logModelSignIn(session, "replaced");
      session.abort.abort(
        new Error(cause === "replacement" ? "Sign-in replaced." : "Sign-in cancelled."),
      );
      this.removeSession(session, cause === "replacement" ? "replaced" : "cancelled");
      return;
    }
  }

  /** Retire every sign-in this user started for one provider, in any space and on any
   *  process — disconnect removes the account credential, so no space's session may
   *  finish afterward. With `credentialId`, only sign-ins that may renew that
   *  connection are retired; a sign-in adding another account carries on. The shared provider
   *  lock orders this against begin on this process. */
  async cancelProvider(input: {
    userId: string;
    provider: string;
    credentialId?: string;
  }): Promise<void> {
    await this.withReplacementLock(
      oauthProviderKey(input.userId, input.provider),
      undefined,
      async () => {
        const scopes = [
          ...new Set(
            [...this.pending.values()]
              .filter(
                (session) =>
                  session.userId === input.userId &&
                  session.provider === input.provider &&
                  (!input.credentialId ||
                    session.credentialId === input.credentialId ||
                    // A sign-in that never named its connection may renew this one.
                    session.credentialId === undefined),
              )
              .map((session) => session.scope),
          ),
        ];
        for (const scope of scopes) {
          await this.retireActiveSession(scope, undefined, "disconnect");
        }
        const handoff = this.handoff;
        if (!handoff) return;
        const where = {
          userId: input.userId,
          provider: input.provider,
          ...(input.credentialId
            ? { scope: { endsWith: oauthScopeConnectionSuffix(input.credentialId) } }
            : {}),
        };
        await runAsSystem("retire a disconnected provider's sign-ins in every Space", async () => {
          await this.endRows(where, "cancelled");
          await handoff.prisma.modelOAuthSession.deleteMany({
            where: { ...where, status: { not: "saving" } },
          });
          // A save under way on another process lands before the caller removes the
          // connection. Its process renews the lease until the save settles, or stops.
          while (
            await handoff.prisma.modelOAuthSession.findFirst({
              where: { ...where, status: "saving", leaseExpiresAt: { gt: new Date() } },
              select: { id: true },
            })
          ) {
            await sleep(SAVE_WAIT_POLL_MS);
          }
        });
      },
    );
  }

  /** Drops a sign-in the person or the clock ended, and reports it if it was still waiting. */
  private removeSession(session: Session<T>, ended: PiOAuthEnd["reason"]): void {
    session.stoppedAs = ended;
    const owned = session.lease !== undefined;
    const waiting = session.state === "pending" ? this.pendingOf(session) : undefined;
    this.detachSession(session);
    if (!this.handoff) this.report(waiting, { reason: ended }, session.id);
    // A pasted code another process received is that process's to finish.
    if (session.stored) void this.forgetRow(session, { unclaimedOnly: !owned, ended });
  }

  private detachSession(session: Session<T>): void {
    this.releaseLease(session);
    if (session.expiresTimer) clearTimeout(session.expiresTimer);
    session.expiresTimer = undefined;
    if (this.pending.get(session.id) === session) this.pending.delete(session.id);
    if (this.activeByScope.get(session.scope) === session) {
      this.activeByScope.delete(session.scope);
    }
  }

  /** Delete a stored sign-in unless its credential is being saved. With `ended`, one
   *  still waiting for the person is reported as ending that way. */
  private async forgetRow(
    ref: RowRef,
    options: { unclaimedOnly?: boolean; ended?: PiOAuthEnd["reason"] } = {},
  ): Promise<void> {
    const handoff = this.handoff;
    if (!handoff) return;
    const { ended } = options;
    try {
      await runAsTenant({ userId: ref.userId, spaceId: ref.spaceId }, async () => {
        if (ended)
          await this.endRows(options.unclaimedOnly ? unclaimedRow(ref) : rowOf(ref), ended);
        await handoff.prisma.modelOAuthSession.deleteMany({
          where: options.unclaimedOnly
            ? unclaimedRow(ref)
            : { ...rowOf(ref), status: { not: "saving" } },
        });
      });
    } catch (error) {
      getLogger().error("model sign-in hand-off not deleted", error, {
        "model.sign_in.id": ref.id,
      });
    }
  }

  /** Shutdown: sign-ins this process was exchanging fail now; a pasted-code sign-in still
   *  waiting for its code stays so the next API process can finish it. */
  async abortAll(): Promise<void> {
    const sessions = [...this.pending.values()];
    const interrupted = sessions.filter((session) => session.lease && session.state === "pending");
    // A save under way finishes and records its outcome before the database closes.
    const saving = sessions.flatMap((session) =>
      session.state === "finalizing" && session.finishing ? [session.finishing] : [],
    );
    for (const session of sessions) {
      if (session.state === "finalizing") continue;
      session.stoppedAs = "interrupted";
      this.detachSession(session);
      session.abort.abort();
    }
    for (const session of this.handoff ? interrupted : sessions) {
      if (session.state === "pending") logModelSignIn(session, "interrupted");
    }
    await Promise.all([
      ...saving,
      ...interrupted.map(async (session) => {
        const failed = { status: "failed", error: SIGN_IN_INTERRUPTED } as const;
        if (await this.writeOutcome(session, failed, "pending")) {
          this.report(this.pendingOf(session), { reason: "interrupted" }, session.id);
        }
      }),
    ]);
    for (const session of sessions) {
      this.detachSession(session);
      session.abort.abort();
    }
  }
}

function rowOf(ref: RowRef) {
  return { id: ref.id, userId: ref.userId, spaceId: ref.spaceId };
}

function unclaimedRow(ref: RowRef) {
  return { ...rowOf(ref), status: "pending", leaseExpiresAt: null };
}

function leaseEnd(): Date {
  return new Date(Date.now() + SIGN_IN_LEASE_MS);
}

function pastedCodeCutoff(): Date {
  return new Date(Date.now() - PASTED_CODE_TTL_SECONDS * 1000);
}

function defaultLogin(
  providerId: string,
  type: "oauth",
  interaction: AuthInteraction,
  options: { codePage?: boolean; verifier?: string } = {},
): Promise<Credential> {
  if (providerId === ANTHROPIC_OAUTH_PROVIDER) {
    const { verifier } = options;
    return createManualAnthropicOAuthLogin({
      codePage: options.codePage,
      ...(verifier ? { createVerifier: () => verifier } : {}),
    })(interaction);
  }
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

/** A new sign-in replaces a pending one for the same connection, or for a new connection. */
function oauthScopeKey(
  userId: string,
  spaceId: string,
  provider: string,
  credentialId?: string | null,
): string {
  return JSON.stringify([userId, spaceId, provider, credentialId ?? null]);
}

/** How every scope key for one connection ends, whichever member and Space started it. */
function oauthScopeConnectionSuffix(credentialId: string): string {
  return `,${JSON.stringify(credentialId)}]`;
}

// Begins and disconnect cancellation share one lock per user+provider so a
// mid-flight begin cannot install a session after disconnect retires them.
function oauthProviderKey(userId: string, provider: string): string {
  return JSON.stringify([userId, provider]);
}

function httpsAuthorizationUrl(input: string): string {
  const url = new URL(input);
  if (url.protocol !== "https:") throw new Error("Authorization URL must use HTTPS.");
  return url.toString();
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new Error("Sign-in cancelled.");
}
