import { plainTextLinkParts } from "@rakazo/chat-ui/native";
import type { BotAvatarSet } from "@rakazo/contracts";
import type { MentionTextPart } from "@rakazo/core";
import { displayName, everyoneWords, groupMentionNames, splitMentionText } from "@rakazo/core";
import type { ReactNode } from "react";
import { createContext } from "react";

/** Draws the bots a reply announces where its text names them. */
export const MessageMentionsContext = createContext<((id: string) => ReactNode) | undefined>(
  undefined,
);

/** A group member a sent message can name with `@Name`, or everyone in the group. */
export type UserMentionTarget =
  | { kind: "bot"; id: string; name: string; color: string; avatarSet?: BotAvatarSet }
  | { kind: "everyone"; id: "everyone"; name: string };

/** Who a sent message's `@Name` can refer to; absent outside groups. */
export const UserMentionsContext = createContext<
  | {
      targets: readonly UserMentionTarget[];
      onOpenBot: (botId: string, name: string) => void;
    }
  | undefined
>(undefined);

/**
 * The targets a sent message can name: the group's members, plus everyone with two or more. A name
 * two members share, or a bot named everyone, stays plain text: the text alone cannot say which
 * one was meant. The other words for everyone show only when the message wakes every member with
 * them.
 */
export function userMentionTargets(
  members: readonly { botId: string; name: string; color: string; avatarSet?: BotAvatarSet }[],
  text: string,
): UserMentionTarget[] {
  const named = members.map((member) => ({ member, name: displayName(member.name, "Bot") }));
  const names = named.map(({ name }) => name);
  const written = new Set(groupMentionNames(text, names).map((name) => name.toLowerCase()));
  const everyone =
    members.length >= 2
      ? everyoneWords(names).filter((word) => word === "everyone" || written.has(word))
      : [];
  const counts = new Map<string, number>(everyone.map((word) => [word, 1]));
  for (const { name } of named)
    counts.set(name.toLowerCase(), (counts.get(name.toLowerCase()) ?? 0) + 1);
  const targets: UserMentionTarget[] = named
    .filter(({ name }) => counts.get(name.toLowerCase()) === 1)
    .map(({ member, name }) => ({
      kind: "bot",
      id: member.botId,
      name,
      color: member.color,
      avatarSet: member.avatarSet,
    }));
  targets.unshift(
    ...everyone.map((name) => ({ kind: "everyone" as const, id: "everyone" as const, name })),
  );
  return targets;
}

/**
 * A sent message cut into plain runs and mentions; a link, email address or page link is never
 * searched for names.
 */
export function textWithMentions(
  text: string,
  targets: readonly UserMentionTarget[],
): MentionTextPart<UserMentionTarget>[] {
  return plainTextLinkParts(text).flatMap((piece) =>
    piece.type === "text" ? splitMentionText(piece.value, targets) : [{ text: piece.value }],
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

/** Opens a page a reply links as `[title](page:<pageId>)`. */
export const OpenPageContext = createContext<((pageId: string) => void) | undefined>(undefined);
