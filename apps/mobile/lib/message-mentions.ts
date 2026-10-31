import { plainTextLinkParts } from "@rakazo/chat-ui/native";
import type { BotAvatarSet } from "@rakazo/contracts";
import type { MentionTextPart } from "@rakazo/core";
import { splitMentionText } from "@rakazo/core";
import type { ReactNode } from "react";
import { createContext } from "react";

/** Draws the bots a reply announces where its text names them. */
export const MessageMentionsContext = createContext<((id: string) => ReactNode) | undefined>(
  undefined,
);

/** A group member a sent message can name with `@Name`, or everyone in the group. */
export type UserMentionTarget =
  | { kind: "bot"; id: string; name: string; color: string; avatarSet?: BotAvatarSet }
  | { kind: "everyone"; id: "everyone"; name: "everyone" };

/** Who a sent message's `@Name` can refer to; absent outside groups. */
export const UserMentionsContext = createContext<
  | {
      targets: readonly UserMentionTarget[];
      onOpenBot: (botId: string, name: string) => void;
    }
  | undefined
>(undefined);

/** The targets a sent message can name: the group's members, plus everyone with two or more. */
export function userMentionTargets(
  members: readonly { botId: string; name: string; color: string; avatarSet?: BotAvatarSet }[],
): UserMentionTarget[] {
  const targets: UserMentionTarget[] = members.map((member) => ({
    kind: "bot",
    id: member.botId,
    name: member.name,
    color: member.color,
    avatarSet: member.avatarSet,
  }));
  if (members.length >= 2) targets.unshift({ kind: "everyone", id: "everyone", name: "everyone" });
  return targets;
}

/** A sent message cut into plain runs and mentions; a link or email address is never searched for names. */
export function textWithMentions(
  text: string,
  targets: readonly UserMentionTarget[],
): MentionTextPart<UserMentionTarget>[] {
  return plainTextLinkParts(text).flatMap((piece) =>
    piece.type === "link" ? [{ text: piece.value }] : splitMentionText(piece.value, targets),
  );
}

/** The bots a sent message names, each once, in the order they first appear. */
export function mentionedBots(
  parts: readonly { target?: UserMentionTarget }[],
): Extract<UserMentionTarget, { kind: "bot" }>[] {
  const bots = new Map<string, Extract<UserMentionTarget, { kind: "bot" }>>();
  for (const part of parts)
    if (part.target?.kind === "bot" && !bots.has(part.target.id))
      bots.set(part.target.id, part.target);
  return [...bots.values()];
}
