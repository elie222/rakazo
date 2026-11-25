import type { MessagingOutbound } from "@rakazo/adapter-kit";
import { isVitestRuntime } from "@rakazo/core/node/test-runtime";
import { inboundOrigin } from "../ingress/ingress-factory.js";
import { larkMessaging } from "../providers/messaging/lark/lark-messaging.js";
import { photonMessaging } from "../providers/messaging/photon/photon-messaging.js";
import { sendblueMessaging } from "../providers/messaging/sendblue/sendblue-messaging.js";
import { slackMessaging } from "../providers/messaging/slack/slack-messaging.js";
import { teamsMessaging } from "../providers/messaging/teams/teams-messaging.js";
import { telegramMessaging } from "../providers/messaging/telegram/telegram-messaging.js";
import { whatsappMessaging } from "../providers/messaging/whatsapp/whatsapp-messaging.js";
import type { MessagingPlatform } from "./chat-sdk-surface.js";
import type {
  MessagingEnvBindings,
  MessagingEnvValues,
  MessagingMountOptions,
  MessagingPlatformDefinition,
} from "./messaging-platform-descriptor.js";

/** Every messaging platform this build has, by id, in the order they mount. */
export const messagingPlatforms = {
  sendblue: sendblueMessaging,
  slack: slackMessaging,
  teams: teamsMessaging,
  whatsapp: whatsappMessaging,
  telegram: telegramMessaging,
  lark: larkMessaging,
  photon: photonMessaging,
};

type Platforms = typeof messagingPlatforms;
type EnvOf<P> = P extends MessagingPlatformDefinition<infer E> ? MessagingEnvValues<E> : never;
type UnionToIntersection<U> = (U extends unknown ? (value: U) => void : never) extends (
  value: infer I,
) => void
  ? I
  : never;
type PlatformValues = UnionToIntersection<
  { [P in keyof Platforms]: EnvOf<Platforms[P]> }[keyof Platforms]
>;

/**
 * Parsed platform credentials, filled from the environment at the composition
 * roots. A platform mounts when every setting it requires is present.
 */
export type MessagingEnvironmentValues = {
  /** The app's own API origin, for redirects a signed-in browser follows. */
  apiUrl?: string | undefined;
  /** The origin vendors that push delivery status call back to: the published one, else API_URL. */
  inboundOrigin?: string | undefined;
} & { [K in keyof PlatformValues]?: PlatformValues[K] | undefined };

const definitions = Object.values(messagingPlatforms) as MessagingPlatformDefinition[];

/** Trimmed, with a blank value unset, in the API and the worker alike. */
export function messagingEnvFromProcess(
  env: Record<string, string | undefined>,
): MessagingEnvironmentValues {
  const values: Record<string, unknown> = {
    apiUrl: clean(env.API_URL),
    inboundOrigin: inboundOrigin(env) ?? clean(env.API_URL),
  };
  for (const definition of definitions) {
    for (const [option, binding] of Object.entries(definition.env)) {
      values[option] = "read" in binding ? binding.read(env) : clean(env[binding.name]);
    }
  }
  return values as MessagingEnvironmentValues;
}

function clean(value: string | undefined) {
  return value?.trim() || undefined;
}

/**
 * Group conversations stay sendblue-only until channel semantics are mapped
 * for the other platforms.
 *
 * `pollInboundMessages` must be true only in the one process that registers
 * the inbound sink. Telegram's "auto" mode long-polls as soon as anything,
 * including a lazy outbound send, initializes the chat, and a second poller
 * steals Telegram's single getUpdates slot, so both processes lose 409
 * Conflicts and messages stop arriving. Send-only callers leave it false.
 */
export function messagingPlatformsFromEnv(
  env: MessagingEnvironmentValues,
  options: MessagingMountOptions = {},
): MessagingPlatform[] {
  const values = env as MessagingEnvValues<MessagingEnvBindings>;
  const context = { ...options, inboundOrigin: env.inboundOrigin };
  const platforms: MessagingPlatform[] = [];
  for (const definition of definitions) {
    const defaultMounted = requiredSettings(definition.env).every((option) => values[option]);
    if (defaultMounted) platforms.push(definition.mount(values, context));
    platforms.push(...(definition.named?.(values, { ...context, defaultMounted }) ?? []));
  }
  return platforms;
}

function requiredSettings(env: MessagingEnvBindings): string[] {
  return Object.entries(env).flatMap(([option, binding]) =>
    "required" in binding && binding.required ? [option] : [],
  );
}

/** Never live under the test runner; tests build surfaces explicitly. */
export function isMessagingEnabled(platforms: MessagingPlatform[]): boolean {
  return platforms.length > 0 && !isVitestRuntime();
}

/**
 * Linked users run on their own credentials, so linking-only deployments
 * need no deployment model. Open signup provisions users with no credential
 * of their own, so that mode requires a configured deployment model — without
 * it their runs cannot execute.
 */
export function isMessagingSurfaceEnabled(
  platforms: MessagingPlatform[],
  options: { deploymentModelConfigured: boolean; openSignup: boolean },
): boolean {
  if (!isMessagingEnabled(platforms)) return false;
  return options.openSignup ? options.deploymentModelConfigured : true;
}

/**
 * Split before enqueueing so retries only resend the parts that failed. The platform that owns
 * the limit does the splitting; a platform that declares none sends the body whole.
 */
export function splitOutboundBody(outbound: MessagingOutbound | undefined, body: string): string[] {
  if (!body.trim()) return [];
  return outbound?.split?.(body) ?? [body];
}
