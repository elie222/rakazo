import * as z from "zod";
import { Id } from "./ids.js";

export const NativeLoginHarnessSchema = z.enum(["codex", "kimi"]);
export const NativeLoginDescriptorSchema = z.object({
  kind: z.literal("native_login"),
  installationId: z.string().regex(/^[a-f0-9]{32}$/),
  harness: NativeLoginHarnessSchema,
  connectionId: z.string().uuid(),
  epoch: z.string().uuid(),
  computerId: Id,
  computerProviderRef: z.string().min(1).max(512),
  computerHomeKey: z.string().min(1).max(512),
  spaceId: Id,
  state: z.enum(["pending", "ready", "disconnected"]),
  region: z.enum(["global", "mainland-cn"]).default("global"),
});
export type NativeLoginDescriptor = z.infer<typeof NativeLoginDescriptorSchema>;

export const NativeLoginStateSchema = z.discriminatedUnion("state", [
  z.object({
    state: z.literal("pending"),
    verificationUri: z.string().url(),
    userCode: z.string().max(256),
    expiresAt: z.string().nullable(),
  }),
  z.object({
    state: z.literal("ready"),
    accountLabel: z.string().max(200).nullable(),
    plan: z.string().max(100).nullable(),
  }),
  z.object({ state: z.literal("signed_out") }),
  z.object({
    state: z.literal("failed"),
    code: z.enum(["denied", "expired", "cancelled", "unavailable"]),
  }),
]);
export type NativeLoginState = z.infer<typeof NativeLoginStateSchema>;
export const NativeLoginAccountSchema = z.object({
  credentialId: Id,
  endpoint: z.string().url(),
  label: z.string(),
  harness: NativeLoginHarnessSchema,
  computerId: Id,
  state: NativeLoginStateSchema,
});
export type NativeLoginAccount = z.infer<typeof NativeLoginAccountSchema>;
export const BeginNativeLoginInput = z.object({
  harness: NativeLoginHarnessSchema,
  computerId: Id,
  credentialId: Id.optional(),
  label: z.string().trim().min(1).max(80),
  region: z.enum(["global", "mainland-cn"]).default("global"),
  selfHostedPersonalUse: z.literal(true),
});

export type BeginNativeLogin = z.infer<typeof BeginNativeLoginInput>;

/** Fixed vendor-native routes; native subscription accounts never select a custom API endpoint. */
export function nativeLoginEndpoint(
  descriptor: Pick<NativeLoginDescriptor, "harness" | "region">,
): string {
  return descriptor.harness === "codex"
    ? "https://chatgpt.com/backend-api/codex"
    : descriptor.region === "mainland-cn"
      ? "https://api.kimi.com/coding/v1"
      : "https://api.kimi.ai/coding/v1";
}

export const NativeLoginComputerSchema = z.object({
  id: Id,
  scope: z.enum(["team", "dedicated"]),
  botName: z.string().nullable(),
});
export type NativeLoginComputer = z.infer<typeof NativeLoginComputerSchema>;
export const NativeLoginListSchema = z.object({
  enabled: z.boolean(),
  accounts: z.array(NativeLoginAccountSchema),
  computers: z.array(NativeLoginComputerSchema),
});
export type NativeLoginList = z.infer<typeof NativeLoginListSchema>;

/** Device sign-in links are vendor destinations, never model-controlled arbitrary URLs. */
export function isNativeLoginVerificationUri(harness: "codex" | "kimi", value: string): boolean {
  try {
    const url = new URL(value);
    const hosts =
      harness === "codex"
        ? ["auth.openai.com"]
        : ["auth.kimi.ai", "www.kimi.ai", "kimi.ai", "auth.kimi.com", "www.kimi.com", "kimi.com"];
    return (
      value.length <= 2048 &&
      url.protocol === "https:" &&
      hosts.includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.port &&
      !url.hash &&
      !Array.from(value).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    );
  } catch {
    return false;
  }
}
