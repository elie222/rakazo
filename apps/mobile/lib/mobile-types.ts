import type {
  Bot,
  BotSection,
  ComputerStatus,
  Group,
  Me,
  ModelCatalogEntry,
  ModelCredential,
  Space,
  SpaceNavigation,
  ThreadSnapshot,
} from "@rakazo/contracts";
import type { LiveThreadMessage, LiveThreadRun, ThreadHistory } from "@rakazo/core";
import { channelMessageLine, prependThreadHistoryPage } from "@rakazo/core";

export type MobileBot = Pick<
  Bot,
  | "id"
  | "name"
  | "preview"
  | "color"
  | "avatarSet"
  | "instructionHistory"
  | "notifyOnFinish"
  | "threadId"
  | "pinned"
  | "status"
  | "threadStatus"
  | "sectionId"
  | "archivedAt"
  | "unread"
  | "updatedAt"
  | "computerMode"
  | "modelProvider"
  | "modelId"
  | "thinkingLevel"
  | "autoSpeak"
  | "fleetManagement"
  | "crossSpaceCommunication"
  | "dailyCheckIns"
> &
  Partial<Pick<Bot, "parentBotId" | "spaceId" | "instructions" | "snoozedUntil">>;
export type MobileBotSection = BotSection;
export type MobileMe = Pick<
  Me,
  | "userId"
  | "name"
  | "email"
  | "spaceId"
  | "defaultProvider"
  | "defaultModel"
  | "hostCredentialProvider"
  | "hostCredentialSource"
  | "needsModel"
  | "isDeploymentOwner"
  | "needsSignupSurvey"
  | "billingEnabled"
  | "paymentWalletProvider"
  | "ticketBoardEnabled"
  | "botAvatarSet"
>;
export type MobileModel = ModelCatalogEntry;
/** Shared DTO includes headerNames only; header values remain in the server secret. */
export type MobileModelCredential = ModelCredential;
/** Live progress and streaming rows are shown before they have a seq, thread, or time. */
export type MobileMessage = LiveThreadMessage;
export type MobileGroup = Pick<
  Group,
  | "id"
  | "name"
  | "preview"
  | "pinned"
  | "sectionId"
  | "archivedAt"
  | "unread"
  | "updatedAt"
  | "members"
> &
  Partial<Pick<Group, "spaceId" | "snoozedUntil">>;
export type MobileSpace = Space;
export type MobileSpaceNavigation = SpaceNavigation;
/**
 * A thread as the screen holds it: live events patch it between refreshes, and a saved chat
 * reopens without its cursor, runs, or computer.
 */
export type MobileSnapshot = Omit<
  ThreadSnapshot,
  "cursor" | "messages" | "run" | "activeRuns" | "computer"
> & {
  cursor?: ThreadSnapshot["cursor"];
  messages: MobileMessage[];
  run: LiveThreadRun | null;
  activeRuns?: LiveThreadRun[];
  computer?: Pick<
    ComputerStatus,
    "state" | "controlHolder" | "screenAvailable" | "mode" | "busyBotName"
  >;
};
export function shouldApplyMobileThreadRefresh(input: {
  requestEpoch: number;
  currentEpoch: number;
  targetBotId: string | undefined;
  targetGroupId: string | undefined;
  activeBotId: string | undefined;
  activeGroupId: string | undefined;
}) {
  return (
    input.requestEpoch === input.currentEpoch &&
    input.targetBotId === input.activeBotId &&
    input.targetGroupId === input.activeGroupId
  );
}
/**
 * What a refresh may hand the live subscription. The server replays events
 * after this snapshot's cursor, so an uncommitted fetch must not supply it.
 */
export function mobileThreadRefreshResult(input: {
  fetched: MobileSnapshot;
  onScreen: MobileSnapshot | null;
  requestGeneration: number;
  currentGeneration: number;
  requestEpoch: number;
  currentEpoch: number;
  targetBotId: string | undefined;
  targetGroupId: string | undefined;
  activeBotId: string | undefined;
  activeGroupId: string | undefined;
}): { commit: boolean; snapshot: MobileSnapshot | null } {
  // Live events may advance the screen while this snapshot is in flight.
  const commit =
    input.requestGeneration === input.currentGeneration &&
    shouldApplyMobileThreadRefresh(input) &&
    (input.onScreen?.threadId !== input.fetched.threadId ||
      (input.fetched.cursor ?? -1) >= (input.onScreen.cursor ?? -1));
  return { commit, snapshot: commit ? input.fetched : input.onScreen };
}
export type MobileMessagePage = ThreadHistory<MobileMessage>;
export function prependMobileMessagePage(
  prev: MobileSnapshot | null,
  page: MobileMessagePage,
): MobileSnapshot | null {
  return prependThreadHistoryPage(prev, page);
}
export function blockText(message: MobileMessage) {
  return message.blocks
    .map((block) => {
      if (block.kind === "channel_message") return channelMessageLine(block);
      if (block.kind === "cloud_agent")
        return `${block.title}: ${block.status}${block.prUrl ? ` ${block.prUrl}` : ""}`;
      if (block.kind === "subagent") {
        return `${block.name ?? "subagent"}: ${block.result || block.progress || block.task || ""}`;
      }
      if (block.kind === "child_bot") {
        return `${block.status === "archived" ? "Archived" : block.status === "deleted" ? "Deleted" : "Bot"} ${block.name ?? ""}`;
      }
      if (block.kind === "chart") return `[chart: ${block.name ?? "chart"}]`;
      if (block.kind === "app") return `[app: ${block.server}]`;
      if (block.kind === "page") return `[page: ${block.title}]`;
      if (block.kind === "image") return `[image: ${block.name ?? "attachment"}]`;
      if (block.kind === "file") {
        return `[file: ${block.name ?? "attachment"}${block.size ? ` (${block.size} bytes)` : ""}]`;
      }
      if (block.kind === "steps") {
        return (block.steps ?? [])
          .map((step) => `${step.label}${step.count > 1 ? ` ×${step.count}` : ""}`)
          .join(", ");
      }
      return ("text" in block ? block.text : "state" in block ? block.state : "") ?? "";
    })
    .filter(Boolean)
    .join("\n");
}
