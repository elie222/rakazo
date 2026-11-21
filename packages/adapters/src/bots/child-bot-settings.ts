import type { VoiceInfo } from "@rakazo/contracts";
import { ComputerModeSchema } from "@rakazo/contracts";
import { redactSecrets } from "@rakazo/core";
import type { FleetCardSummary } from "../approvals/approval-ask.js";
import { approvalDetailLength, MAX_APPROVAL_SUMMARY_LENGTH } from "../approvals/approval-ask.js";
import type { FleetPrepareDeps, FleetRun } from "../tools/fleet-tools.js";
import { cardName, credentialField, NOT_FOUND, resolveBot } from "../tools/fleet-tools.js";
import { prepareOwnBotSettings } from "./own-bot-settings.js";
import type { ChildBotSettings } from "./update-bot-patch.js";
import {
  argumentGiven,
  BOT_SETTING_ARGS,
  parseBotSettingsPatch,
  parseUpdateBotPatch,
} from "./update-bot-patch.js";

/** The `update_bot` fields that change how another bot works rather than how it is shown. */
const CHILD_SETTING_ARGS = [...BOT_SETTING_ARGS, "readAloud", "voice", "computer"];

export function childSettingsGiven(args: Record<string, unknown>): boolean {
  return CHILD_SETTING_ARGS.some((key) => argumentGiven(args[key]));
}

const onOff = (value: boolean) => (value ? "on" : "off");

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
  if (argumentGiven(args.model) || argumentGiven(args.thinkingLevel))
    return { error: "Change another bot's model with set_child_bot_model." };
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
  const child = await resolveBot(deps.prisma, run, { bot_id: args.bot_id });
  if ("error" in child) return child;
  if (!child.thread) return { error: NOT_FOUND };
  const current = await deps.prisma.bot.findUniqueOrThrow({
    where: { id: child.id },
    select: { disabledBuiltinTools: true, computer: { select: { scope: true } } },
  });
  const voice = await prepareOwnBotSettings(
    deps,
    run,
    child,
    { readAloud: args.readAloud, voice: args.voice },
    deps.listVoices,
  );
  if ("error" in voice) return voice;
  const work = parseBotSettingsPatch(args, {
    id: child.id,
    disabledBuiltinTools: current.disabledBuiltinTools,
  });
  if ("error" in work) return work;
  const settings: ChildBotSettings = { ...work.patch, ...voice.data };
  if (computer?.success) {
    if (!current.computer) return { error: "That bot has no computer to change." };
    const mode = current.computer.scope === "dedicated" ? "dedicated" : "team";
    if (mode !== computer.data) settings.computerMode = computer.data;
  }
  if (!Object.keys(settings).length) return { error: "That bot already has these settings." };

  const lines: string[] = [];
  const { patch } = profile;
  if (patch.name !== undefined) lines.push(`Name: ${patch.name}`);
  if (patch.description !== undefined) lines.push(`Description: ${patch.description}`);
  if (patch.notifyOnFinish !== undefined)
    lines.push(`Notify when done: ${onOff(patch.notifyOnFinish)}`);
  if (patch.dailyCheckIns !== undefined)
    lines.push(`Daily check-ins: ${onOff(patch.dailyCheckIns)}`);
  if (argumentGiven(args.color)) lines.push(`Avatar: ${String(args.color)}`);
  if (settings.autoSpeak !== undefined) lines.push(`Read aloud: ${onOff(settings.autoSpeak)}`);
  if (settings.voiceId !== undefined) lines.push(`Voice: ${String(args.voice).trim()}`);
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
  if (settings.teamChatRules !== undefined)
    lines.push(`Team chat rules: ${settings.teamChatRules}`);
  if (settings.memoryScope)
    lines.push(settings.memoryScope === "shared" ? "Memory: shared" : "Memory: its own");
  if (settings.disabledBuiltinTools) {
    const off = settings.disabledBuiltinTools.filter(
      (name) => !current.disabledBuiltinTools.includes(name),
    );
    lines.push(`Turn off: ${off.join(", ")}`);
  }
  if (settings.computerMode)
    lines.push(
      settings.computerMode === "dedicated" ? "Computer: its own" : "Computer: the team computer",
    );
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
      ...(argumentGiven(args.color) ? { color: args.color } : {}),
      settings,
    },
    summary,
  };
}
