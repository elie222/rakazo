import type { VoiceInfo } from "@rakazo/contracts";
import { ComputerModeSchema } from "@rakazo/contracts";
import { ClientError, redactSecrets } from "@rakazo/core";
import type { ThreadEvents } from "@rakazo/db";
import { commitBotUpdate, createRepos } from "@rakazo/db";
import type { FleetCardSummary } from "../approvals/approval-ask.js";
import { approvalDetailLength, MAX_APPROVAL_SUMMARY_LENGTH } from "../approvals/approval-ask.js";
import type { BotComputerSwitchDeps } from "../computers/bot-computer-switch.js";
import { switchBotComputer } from "../computers/bot-computer-switch.js";
import type { FleetDeps, FleetPrepareDeps, FleetRun } from "../tools/fleet-tools.js";
import {
  actorOf,
  cardName,
  credentialField,
  invisibleField,
  NOT_FOUND,
  resolveBot,
} from "../tools/fleet-tools.js";
import { resolveUpdateBotAvatar } from "./bot-avatar.js";
import { prepareOwnBotSettings } from "./own-bot-settings.js";
import type { ChildBotSettings, UpdateBotPatch } from "./update-bot-patch.js";
import {
  argumentGiven,
  BOT_SETTING_ARGS,
  botSettingsData,
  ChildBotSettingsSchema,
  parseBotSettingsPatch,
  parseUpdateBotPatch,
} from "./update-bot-patch.js";

/** The `update_bot` fields that change how another bot works rather than how it is shown. */
const CHILD_SETTING_ARGS = [...BOT_SETTING_ARGS, "readAloud", "voice", "computer"];

export function childSettingsGiven(args: Record<string, unknown>): boolean {
  return CHILD_SETTING_ARGS.some((key) => argumentGiven(args[key]));
}

const onOff = (value: boolean) => (value ? "on" : "off");

/** Fields `update_bot` takes only for the calling bot itself. */
function ownOnlyFieldRefusal(args: Record<string, unknown>): { error: string } | undefined {
  if (argumentGiven(args.artifact_id) || args.use_attached_image === true)
    return { error: "artifact_id and use_attached_image work only on yourself." };
  if (argumentGiven(args.instructions))
    return { error: "Change another bot's instructions with set_child_instructions." };
  if (argumentGiven(args.model) || argumentGiven(args.thinkingLevel))
    return { error: "Change another bot's model with set_child_bot_model." };
  return undefined;
}

/**
 * Checks an `update_bot` on another bot that changes its settings, as the settings screen would,
 * and builds the request the owner approves: the stored request is what replay applies, so the
 * card shows exactly that.
 */
export async function prepareChildBotUpdate(
  deps: FleetPrepareDeps & { listVoices: () => Promise<VoiceInfo[] | null> },
  run: FleetRun,
  args: Record<string, unknown>,
  secrets: readonly string[],
): Promise<
  { ok: true; canonical: Record<string, unknown>; summary: FleetCardSummary } | { error: string }
> {
  const ownOnly = ownOnlyFieldRefusal(args);
  if (ownOnly) return ownOnly;
  const computer = argumentGiven(args.computer)
    ? ComputerModeSchema.safeParse(args.computer)
    : undefined;
  if (computer && !computer.success) return { error: "computer must be team or dedicated." };
  const profileGiven = [
    "name",
    "description",
    "notifyOnFinish",
    "notify_on_finish",
    "dailyCheckIns",
  ].some((key) => argumentGiven(args[key]));
  const profile = profileGiven ? parseUpdateBotPatch(args) : { patch: {} };
  if ("error" in profile) return profile;
  const credential = credentialField(
    {
      name: profile.patch.name,
      description: profile.patch.description,
      teamChatRules: args.teamChatRules,
    },
    secrets,
  );
  if (credential) return { error: credential };
  // The owner approves the rules as the card shows them, so none may hide from it.
  const hidden =
    typeof args.teamChatRules === "string" && invisibleField({ teamChatRules: args.teamChatRules });
  if (hidden) return { error: hidden };
  const child = await resolveBot(deps.prisma, run, { bot_id: args.bot_id });
  if ("error" in child) return child;
  if (!child.thread) return { error: NOT_FOUND };
  if (child.id === run.botId) return { error: "Change your own settings without bot_id." };
  let color: string | undefined;
  if (argumentGiven(args.color)) {
    const avatar = await resolveUpdateBotAvatar({
      color: args.color,
      sourceImageArtifactIds: [],
      loadArtifact: async () => null,
    });
    if ("error" in avatar) return avatar;
    color = avatar.color;
  }
  const current = await deps.prisma.bot.findUniqueOrThrow({
    where: { id: child.id },
    select: {
      disabledBuiltinTools: true,
      computer: { select: { scope: true } },
      replyMode: true,
      teamChatAmbientEnabled: true,
      teamChatRules: true,
      memoryScope: true,
      autoSpeak: true,
      voiceId: true,
    },
  });
  let voices: VoiceInfo[] | null = null;
  const voice = await prepareOwnBotSettings(
    deps,
    run,
    child,
    { readAloud: args.readAloud, voice: args.voice },
    async () => {
      voices = await deps.listVoices();
      return voices;
    },
  );
  if ("error" in voice) return voice;
  const work = parseBotSettingsPatch(args, {
    id: child.id,
    disabledBuiltinTools: current.disabledBuiltinTools,
  });
  if ("error" in work) return work;
  // A setting the bot already has is no change, so a call repeating one stays a profile edit.
  const settings: ChildBotSettings = Object.fromEntries(
    Object.entries({ ...work.patch, ...voice.data }).filter(
      ([key, value]) => current[key as keyof typeof current] !== value,
    ),
  );
  if (computer?.success) {
    if (!current.computer) return { error: "That bot has no computer to change." };
    const mode = current.computer.scope === "dedicated" ? "dedicated" : "team";
    if (mode !== computer.data) settings.computerMode = computer.data;
  }
  const changesSettings = Object.keys(settings).length > 0;
  if (!changesSettings && !profileGiven && color === undefined)
    return { error: "That bot already has these settings." };

  const lines: string[] = [];
  const { patch } = profile;
  if (patch.name !== undefined) lines.push(`Name: ${patch.name}`);
  if (patch.description !== undefined) lines.push(`Description: ${patch.description}`);
  if (patch.notifyOnFinish !== undefined)
    lines.push(`Notify when done: ${onOff(patch.notifyOnFinish)}`);
  if (patch.dailyCheckIns !== undefined)
    lines.push(`Daily check-ins: ${onOff(patch.dailyCheckIns)}`);
  if (color !== undefined) lines.push(`Avatar: ${color}`);
  if (settings.autoSpeak !== undefined) lines.push(`Read aloud: ${onOff(settings.autoSpeak)}`);
  if (settings.voiceId !== undefined) {
    const chosen = (voices as VoiceInfo[] | null)?.find((entry) => entry.id === settings.voiceId);
    lines.push(`Voice: ${chosen?.label ?? "Default"}`);
  }
  if (settings.replyMode)
    lines.push(
      settings.replyMode === "messages" ? "Replies: only messages it sends" : "Replies: in chat",
    );
  if (settings.teamChatAmbientEnabled !== undefined)
    lines.push(
      settings.teamChatAmbientEnabled
        ? "Team chat: reads every message"
        : "Team chat: only when mentioned",
    );
  if (settings.memoryScope)
    lines.push(settings.memoryScope === "shared" ? "Memory: shared" : "Memory: its own");
  if (settings.disableTools) lines.push(`Turn off: ${settings.disableTools.join(", ")}`);
  if (settings.computerMode)
    lines.push(
      settings.computerMode === "dedicated" ? "Computer: its own" : "Computer: the team computer",
    );
  // Last and under their own heading, so a line inside the rules can't pass for another change.
  if (settings.teamChatRules !== undefined)
    lines.push("", "Team chat rules:", settings.teamChatRules);
  const summary = { title: `Change ${cardName(child.name)}’s settings?`, lines };
  if (
    redactSecrets(summary.title, [...secrets]).length > MAX_APPROVAL_SUMMARY_LENGTH ||
    redactSecrets(lines.join("\n"), [...secrets]).length > approvalDetailLength("update_bot")
  )
    return { error: "This request is too long to show on the approval card. Shorten it." };
  return {
    ok: true,
    canonical: {
      bot_id: child.id,
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.notifyOnFinish !== undefined ? { notifyOnFinish: patch.notifyOnFinish } : {}),
      ...(patch.dailyCheckIns !== undefined ? { dailyCheckIns: patch.dailyCheckIns } : {}),
      ...(color !== undefined ? { color } : {}),
      ...(changesSettings ? { settings } : {}),
    },
    summary,
  };
}

/**
 * `update_bot` with `bot_id`: the profile of another bot in the space, and once the owner's
 * approval mode passes it, the settings `prepareChildBotUpdate` checked.
 */
export async function updateChildBot(
  deps: Pick<FleetDeps, "prisma"> &
    Pick<BotComputerSwitchDeps, "home" | "sandbox"> & {
      events: Pick<ThreadEvents, "append" | "notify" | "draftRecordingsOfLease">;
      runSecrets: readonly string[];
    },
  run: FleetRun,
  args: Record<string, unknown>,
): Promise<{ ok: true } | { error: string }> {
  const ownOnly = ownOnlyFieldRefusal(args);
  if (ownOnly) return ownOnly;
  const profile = {
    dailyCheckIns: argumentGiven(args.dailyCheckIns) ? args.dailyCheckIns : undefined,
    name: argumentGiven(args.name) ? args.name : undefined,
    description: argumentGiven(args.description) ? args.description : undefined,
    notifyOnFinish: argumentGiven(args.notifyOnFinish)
      ? args.notifyOnFinish
      : argumentGiven(args.notify_on_finish)
        ? args.notify_on_finish
        : undefined,
  };
  const credential = credentialField(
    { name: profile.name, description: profile.description },
    deps.runSecrets,
  );
  if (credential) return { error: credential };

  const child = await resolveBot(deps.prisma, run, { bot_id: args.bot_id });
  if ("error" in child) {
    return { error: child.error };
  }
  if (!child.thread) return { error: NOT_FOUND };

  let patch: UpdateBotPatch = {};
  if (Object.values(profile).some((value) => value !== undefined)) {
    const parsed = parseUpdateBotPatch(profile);
    if ("error" in parsed) return parsed;
    patch = parsed.patch;
  }
  if (argumentGiven(args.color)) {
    const avatar = await resolveUpdateBotAvatar({
      color: args.color,
      sourceImageArtifactIds: [],
      loadArtifact: async () => null,
    });
    if ("error" in avatar) return avatar;
    patch.color = avatar.color;
  }
  const approved = ChildBotSettingsSchema.safeParse(args.settings ?? {});
  if (!approved.success) return { error: "The approved change is incomplete." };
  const { computerMode, ...settings } = approved.data;
  if (Object.keys(patch).length === 0 && args.settings === undefined) {
    return {
      error: "Provide at least one of name, description, notify_on_finish, or color.",
    };
  }
  if (computerMode) {
    try {
      await switchBotComputer(
        { ...deps, repos: createRepos(deps.prisma) },
        actorOf(run),
        child.id,
        computerMode,
      );
    } catch (error) {
      if (error instanceof ClientError) return { error: error.message };
      throw error;
    }
  }
  const data = { ...patch, ...botSettingsData(settings) };
  if (Object.keys(data).length)
    await commitBotUpdate({
      prisma: deps.prisma,
      notify: (threadId, seq) => deps.events.notify(threadId, seq),
      spaceId: run.spaceId,
      threadId: child.thread.id,
      botId: child.id,
      emitBotUpdated: true,
      data,
    });
  return { ok: true };
}
