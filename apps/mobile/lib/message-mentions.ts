import { plainTextLinkParts } from "@rakazo/chat-ui/native";
import type { BotAvatarSet } from "@rakazo/contracts";
import type { MentionTextPart } from "@rakazo/core";
import {
  displayName,
  everyoneWords,
  groupMentionCheck,
  groupMentionNames,
  splitMentionText,
} from "@rakazo/core";
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
 * one was meant. The other words for everyone show only where they wake every member.
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

type MentionCheck = ReturnType<typeof groupMentionCheck>;

function everyoneCheck(text: string, targets: readonly UserMentionTarget[]): MentionCheck {
  const everyone = targets
    .filter((target) => target.kind === "everyone")
    .map((target) => target.name.toLowerCase());
  return groupMentionCheck(text, everyone);
}

/**
 * Text cut into plain runs and the mentions it makes, read the way the group reads them: "@all" in
 * code or a package name stays plain even where another "@all" in the message wakes everyone.
 * `within` reads a run at `offset` in the whole message, since code and links can span runs.
 */
export function splitUserMentions(
  text: string,
  targets: readonly UserMentionTarget[],
  within?: { counts: MentionCheck; offset: number },
): MentionTextPart<UserMentionTarget>[] {
  const counts = within?.counts ?? everyoneCheck(text, targets);
  let start = within?.offset ?? 0;
  return splitMentionText(text, targets).map((part) => {
    const span = { start, end: start + part.text.length, name: part.text.slice(1) };
    start = span.end;
    return part.target?.kind === "everyone" && !counts(span) ? { text: part.text } : part;
  });
}

/**
 * Splits the text run of `text` that starts at `start` (between its links), read against the whole
 * message: whether an "@all" counts depends on code and links that one run alone may cut off.
 */
export function userMentionRuns(
  text: string,
  targets: readonly UserMentionTarget[],
): (run: string, start: number) => MentionTextPart<UserMentionTarget>[] {
  const counts = everyoneCheck(text, targets);
  return (run, start) => splitUserMentions(run, targets, { counts, offset: start });
}

/**
 * A sent message cut into plain runs and mentions; a link, email address or page link is never
 * searched for names.
 */
export function textWithMentions(
  text: string,
  targets: readonly UserMentionTarget[],
): MentionTextPart<UserMentionTarget>[] {
  const runs = userMentionRuns(text, targets);
  return plainTextLinkParts(text).flatMap((piece) =>
    piece.type === "text" ? runs(piece.value, piece.start) : [{ text: piece.value }],
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
