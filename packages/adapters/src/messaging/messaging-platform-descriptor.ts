import type { HttpInstance } from "@larksuiteoapi/node-sdk";
import type { ClientOptions as SendblueClientOptions } from "sendblue";
import type { MessagingPlatform } from "./chat-sdk-surface.js";

/** A setting read from one environment variable, trimmed, with a blank one unset. */
export interface MessagingEnvVariable {
  name: string;
  /** Without it the platform's default mount stays off. */
  required?: boolean;
}

/** A setting gathered from several variables, such as every `TELEGRAM_BOT_TOKEN_<NAME>`. */
export interface MessagingEnvReader<T> {
  read(source: Record<string, string | undefined>): T;
}

export type MessagingEnvBinding = MessagingEnvVariable | MessagingEnvReader<unknown>;

export type MessagingEnvBindings = Record<string, MessagingEnvBinding>;

/** The values a platform's bindings produce; required variables are present when it mounts. */
export type MessagingEnvValues<E extends MessagingEnvBindings> = {
  [K in keyof E]: E[K] extends MessagingEnvReader<infer T>
    ? T
    : E[K] extends { required: true }
      ? string
      : string | undefined;
};

export interface MessagingMountOptions {
  /** True only in the one process that registers the inbound sink. */
  pollInboundMessages?: boolean;
  /** Test seam: point the Sendblue SDK at an emulator. */
  sendblueTransport?: Pick<SendblueClientOptions, "baseURL" | "fetch">;
  /** Test seam: replace only the official Lark SDK HTTP boundary. */
  larkTransport?: HttpInstance;
}

export interface MessagingMountContext extends MessagingMountOptions {
  /** Public API origin; vendors that push delivery status call back here. */
  apiUrl?: string | undefined;
}

/** One messaging platform: the settings it reads and how it mounts. */
export interface MessagingPlatformDefinition<
  E extends MessagingEnvBindings = MessagingEnvBindings,
> {
  env: E;
  /** The deployment's own mount, called once every required setting is present. */
  mount(values: MessagingEnvValues<E>, context: MessagingMountContext): MessagingPlatform;
  /** Extra mounts configured under named settings, whether or not the default one mounted. */
  named?(
    values: MessagingEnvValues<E>,
    context: MessagingMountContext & { defaultMounted: boolean },
  ): MessagingPlatform[];
}

export function defineMessagingPlatform<const E extends MessagingEnvBindings>(
  definition: MessagingPlatformDefinition<E>,
): MessagingPlatformDefinition<E> {
  return definition;
}

/** Bounds one vendor send so a hung request cannot stall the sequential outbox drain. */
export const MESSAGING_SEND_TIMEOUT_MS = 10_000;

export function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

export function arrayField(record: Record<string, unknown> | null, key: string): unknown[] {
  const value = record?.[key];
  return Array.isArray(value) ? value : [];
}

export function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" && value ? value : undefined;
}
