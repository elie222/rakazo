import type { AdapterContext, ComputerRef, SandboxProvider } from "@rakazo/adapter-kit";
import type { NativeLoginDescriptor, NativeLoginState } from "@rakazo/contracts";
import {
  isNativeLoginVerificationUri,
  NativeLoginDescriptorSchema,
  NativeLoginStateSchema,
} from "@rakazo/contracts";
import { CODEX_AUTH_SANDBOX_RUNNER } from "./primary-harness-auth-codex.js";
import { KIMI_AUTH_SANDBOX_RUNNER } from "./primary-harness-auth-kimi.js";
import { NativeJsonlChannel } from "./primary-harness-protocol.js";

export type { NativeLoginState } from "@rakazo/contracts";
export interface NativeHarnessLoginOptions {
  descriptor: NativeLoginDescriptor;
  sandbox: SandboxProvider;
  computer: ComputerRef;
  context: AdapterContext;
}
export interface NativeHarnessLoginHandle {
  initial: NativeLoginState;
  completion: Promise<NativeLoginState>;
  cancel(): Promise<void>;
}

const MAX_LOGIN_MS = 10 * 60 * 1000;
const OPERATION_TIMEOUT_MS = 30_000;
const CANCEL_GRACE_MS = 1_000;

async function boundedRequest(
  channel: NativeJsonlChannel,
  method: string,
  params: Record<string, unknown>,
  timeoutMs = OPERATION_TIMEOUT_MS,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      channel.request(method, params),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Native login operation timed out.")), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function hasControlCharacters(value: string): boolean {
  return Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127);
}

/** Only sanitized state crosses the isolated process boundary; native tokens never do. */
export function validateNativeLoginState(
  value: unknown,
  harness: "codex" | "kimi",
): NativeLoginState {
  const state = NativeLoginStateSchema.parse(value);
  if (state.state === "pending") {
    const url = new URL(state.verificationUri);
    if (
      !isNativeLoginVerificationUri(harness, state.verificationUri) ||
      url.username ||
      url.password ||
      url.hash ||
      url.port ||
      state.verificationUri.length > 2048 ||
      !state.userCode ||
      hasControlCharacters(state.userCode)
    )
      throw new Error("Native login returned an invalid verification address.");
    const expiration = state.expiresAt === null ? NaN : Date.parse(state.expiresAt);
    if (
      !Number.isFinite(expiration) ||
      expiration <= Date.now() ||
      expiration > Date.now() + MAX_LOGIN_MS + 1000
    )
      throw new Error("Native login returned an invalid expiry.");
  }
  if (
    state.state === "ready" &&
    [state.accountLabel, state.plan].some((value) => value !== null && hasControlCharacters(value))
  )
    throw new Error("Native login returned invalid account metadata.");
  return state;
}

async function open(options: NativeHarnessLoginOptions, timeoutMs = MAX_LOGIN_MS) {
  const descriptor = NativeLoginDescriptorSchema.parse(options.descriptor);
  if (!options.sandbox.startProcess)
    throw new Error("This computer does not support isolated native login.");
  if (
    descriptor.computerProviderRef !== options.computer.id ||
    descriptor.computerProviderRef !== options.computer.providerRef ||
    descriptor.computerHomeKey !== options.computer.botId ||
    options.computer.kind !== "docker" ||
    descriptor.spaceId !== options.context.spaceId ||
    !options.context.userId
  )
    throw new Error("Native login account does not match this computer and owner.");
  if (descriptor.installationId !== options.sandbox.nativeStateInstallationId?.())
    throw new Error(
      "Native login belongs to a different runtime installation. Reconnect the account.",
    );
  options.context.signal.throwIfAborted();
  const signal = AbortSignal.any([options.context.signal, AbortSignal.timeout(timeoutMs)]);
  const process = await options.sandbox.startProcess(
    options.computer,
    {
      isolation: "primary-harness",
      argv: [
        "node",
        "--input-type=module",
        "--eval",
        descriptor.harness === "codex" ? CODEX_AUTH_SANDBOX_RUNNER : KIMI_AUTH_SANDBOX_RUNNER,
      ],
      credentialScope: {
        harness: descriptor.harness,
        connectionId: descriptor.connectionId,
        epoch: descriptor.epoch,
      },
      timeoutMs,
    },
    { ...options.context, signal },
  );
  return new NativeJsonlChannel(process, signal, true);
}

export async function startNativeHarnessLogin(
  options: NativeHarnessLoginOptions,
): Promise<NativeHarnessLoginHandle> {
  const channel = await open(options);
  try {
    const initial = validateNativeLoginState(
      await boundedRequest(channel, "rakazo/auth/start", { region: options.descriptor.region }),
      options.descriptor.harness,
    );
    if (initial.state !== "pending" && initial.state !== "ready")
      throw new Error("Native login could not start.");
    let cancelled = false;
    const completion = (async (): Promise<NativeLoginState> => {
      try {
        if (initial.state === "ready") return initial;
        for await (const message of channel.messages) {
          if (message.id !== undefined && message.method === undefined) continue;
          if (message.method !== "rakazo/auth/state")
            throw new Error("Unexpected native login operation.");
          const state = validateNativeLoginState(message.params, options.descriptor.harness);
          if (state.state === "pending")
            throw new Error("Unexpected repeated native login request.");
          return state;
        }
        return { state: "failed", code: cancelled ? "cancelled" : "unavailable" };
      } catch {
        return { state: "failed", code: cancelled ? "cancelled" : "unavailable" };
      } finally {
        await channel.close();
      }
    })();
    return {
      initial,
      completion,
      cancel: async () => {
        cancelled = true;
        try {
          await boundedRequest(channel, "rakazo/auth/cancel", {}, CANCEL_GRACE_MS);
        } catch {
          /* Closing the process also cancels native polling. */
        } finally {
          await channel.close();
        }
      },
    };
  } catch {
    await channel.close();
    throw new Error("Native login could not start. Check the computer and try again.");
  }
}

async function operation(
  options: NativeHarnessLoginOptions,
  method: string,
): Promise<NativeLoginState> {
  const channel = await open(options, OPERATION_TIMEOUT_MS);
  try {
    return validateNativeLoginState(
      await boundedRequest(channel, method, { region: options.descriptor.region }),
      options.descriptor.harness,
    );
  } finally {
    await channel.close();
  }
}
export function inspectNativeHarnessLogin(
  options: NativeHarnessLoginOptions,
): Promise<NativeLoginState> {
  return operation(options, "rakazo/auth/status");
}
export async function logoutNativeHarnessLogin(options: NativeHarnessLoginOptions): Promise<void> {
  const state = await operation(options, "rakazo/auth/logout");
  if (state.state !== "signed_out") throw new Error("Native account could not be disconnected.");
}
