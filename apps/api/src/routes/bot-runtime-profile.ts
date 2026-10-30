import { ORPCError } from "@orpc/server";
import { BotRuntimeProfile } from "@rakazo/contracts";
import {
  BotRuntimeProfileConflictError,
  IsolationError,
  readBotRuntimeProfile,
  writeBotRuntimeProfile,
} from "@rakazo/db";
import type { RouterContext } from "./context.js";

export const BOT_PROFILE_PARTIAL = "partial" as const;
const SUPPORTED_CAPABILITIES: string[] = ["persona"];

/** The profile contract is ahead of runtime support. Reject settings that could imply activation. */
export function botProfileDraftOnlyProblem(
  settings: ReturnType<typeof BotRuntimeProfile.parse>,
): string | undefined {
  if (settings.extensions.length > 0) return "Extension assignments are not available yet";
  if (settings.skills.mode !== "legacy-library")
    return "Explicit skill selection is not available yet";
    if (settings.learning.mode !== "off") return "Learning is not available yet";
  if (settings.initiative.enabled) return "Initiative is not available yet";
  if (settings.routing.enabled) return "Routing is not available yet";
  return undefined;
}

export function validateBotRuntimeProfileDraft(input: { settings: unknown }) {
  const parsed = BotRuntimeProfile.safeParse(input.settings);
  if (!parsed.success) {
    return {
      valid: false as const,
      activationStatus: BOT_PROFILE_PARTIAL,
      supportedCapabilities: SUPPORTED_CAPABILITIES,
      issues: parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`),
    };
  }
  const problem = botProfileDraftOnlyProblem(parsed.data);
  return {
    valid: problem === undefined,
    activationStatus: BOT_PROFILE_PARTIAL,
    supportedCapabilities: SUPPORTED_CAPABILITIES,
    issues: problem ? [problem] : [],
  };
}

export function mapBotRuntimeProfileError(error: unknown): never {
  if (error instanceof BotRuntimeProfileConflictError) {
    throw new ORPCError("CONFLICT", { message: error.message });
  }
  if (error instanceof IsolationError) throw new ORPCError("NOT_FOUND");
  throw error;
}

function response(botId: string, row: { revision: number; settings: unknown } | null) {
  return {
    botId,
    revision: row?.revision ?? 0,
    settings: BotRuntimeProfile.parse(row?.settings ?? {}),
    activationStatus: BOT_PROFILE_PARTIAL,
    supportedCapabilities: SUPPORTED_CAPABILITIES,
  } as const;
}

export function botRuntimeProfileRouteEntries(ctx: RouterContext) {
  const { deps, authed } = ctx;
  return {
    runtimeProfileGet: authed.bots.runtimeProfileGet.handler(async ({ context, input }) => {
      try {
        const row = await readBotRuntimeProfile(deps.prisma, {
          botId: input.botId,
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
        });
        return response(input.botId, row);
      } catch (error) {
        return mapBotRuntimeProfileError(error);
      }
    }),
    runtimeProfileValidate: authed.bots.runtimeProfileValidate.handler(({ input }) =>
      validateBotRuntimeProfileDraft(input),
    ),
    runtimeProfileUpdate: authed.bots.runtimeProfileUpdate.handler(async ({ context, input }) => {
      const settings = BotRuntimeProfile.parse(input.settings);
      const problem = botProfileDraftOnlyProblem(settings);
      if (problem) throw new ORPCError("BAD_REQUEST", { message: problem });
      try {
        const row = await writeBotRuntimeProfile(deps.prisma, {
          botId: input.botId,
          spaceId: context.actor.spaceId,
          userId: context.actor.userId,
          expectedRevision: input.expectedRevision,
          reason: input.reason,
          settings: settings as never,
        });
        return response(input.botId, row);
      } catch (error) {
        return mapBotRuntimeProfileError(error);
      }
    }),
  };
}
