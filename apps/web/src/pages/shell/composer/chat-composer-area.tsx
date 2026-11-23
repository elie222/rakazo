import { Trans, useLingui } from "@lingui/react/macro";
import type { AgentSkillCatalogEntry, Bot, Group, ThreadSnapshot } from "@rakazo/contracts";
import { channelMessageSender, otherAuthor } from "@rakazo/core";
import type { ComponentProps } from "react";
import type { ArtifactTarget } from "../../../lib/pages/artifact-open";
import type { Panel } from "../right-panel-state";
import type { SettingsSection } from "../shell-overlay-url";
import { Composer } from "./composer";
import { ComposerModelPicker } from "./composer-model-picker";
import type { useComposerActions } from "./use-composer-actions";

type ComposerProps = ComponentProps<typeof Composer>;

/** The open chat's composer, under the transcript, with the teaching notice above it. */
export function ChatComposerArea({
  composer,
  inGroup,
  groupId,
  active,
  activeGroup,
  activeSnapshot,
  meId,
  memberName,
  recordingSkill,
  running,
  enterToSend,
  sendColors,
  modelPicker,
  onBotSaved,
  phoneCallsEnabled,
  dictationTranscribe,
  artifactTarget,
  mentionTargets,
  agentSkills,
  onSlashOpen,
  openSettings,
  openChatSettings,
  setPanel,
  setModelFocusRequest,
}: {
  composer: ReturnType<typeof useComposerActions>;
  inGroup: boolean;
  groupId: string | undefined;
  active: Bot | undefined;
  activeGroup: Group | undefined;
  activeSnapshot: ThreadSnapshot | null;
  meId: string | undefined;
  memberName: (botId: string | undefined) => string | undefined;
  recordingSkill: boolean;
  running: boolean;
  enterToSend: boolean;
  sendColors: ComposerProps["sendColors"];
  /** The model picker's keyboard state, or null when the composer shows no model. */
  modelPicker: Omit<
    ComponentProps<typeof ComposerModelPicker>,
    "bot" | "disabled" | "onSaved" | "onConnect"
  > | null;
  onBotSaved: (bot: Bot) => void;
  phoneCallsEnabled: boolean;
  dictationTranscribe: boolean | undefined;
  artifactTarget: ArtifactTarget;
  mentionTargets: ComposerProps["mentionTargets"];
  agentSkills: AgentSkillCatalogEntry[];
  onSlashOpen: () => void;
  openSettings: (section: SettingsSection) => void;
  openChatSettings: (kind: "bot" | "group", id: string) => void;
  setPanel: (panel: Panel) => void;
  setModelFocusRequest: (request: number) => void;
}) {
  const { t } = useLingui();
  if (!active && !activeGroup) return null;
  const { replyTarget } = composer;
  const replyTargetName = replyTarget
    ? replyTarget.role === "user"
      ? (otherAuthor(replyTarget.author, meId)?.name ??
        channelMessageSender(replyTarget.blocks) ??
        t`You`)
      : (memberName(replyTarget.botId) ?? active?.name ?? t`Bot`)
    : undefined;
  const chatKey = inGroup ? `group:${groupId}` : `bot:${active?.id}`;
  return (
    // Let messages continue behind the composer's rounded top corners.
    <div className="pointer-events-none relative z-30 -mt-7">
      {recordingSkill ? (
        <div className="pointer-events-auto bg-background px-6 pb-2 text-center text-body-sm text-destructive">
          <Trans>Teaching in progress. Stop teaching before sending a new message.</Trans>
        </div>
      ) : null}
      <Composer
        key={chatKey}
        draftKey={chatKey}
        enterToSend={enterToSend}
        sendColors={sendColors}
        modelPicker={
          modelPicker && active && !inGroup ? (
            <ComposerModelPicker
              bot={active}
              disabled={recordingSkill}
              {...modelPicker}
              onConnect={() => openSettings("models")}
              onSaved={onBotSaved}
            />
          ) : undefined
        }
        activeName={inGroup ? (activeGroup?.name ?? activeSnapshot?.groupName) : active?.name}
        running={running}
        disabled={recordingSkill}
        pendingAttachments={composer.activePendingAttachments}
        attachmentNotice={composer.attachmentNotice}
        sendError={composer.sendError}
        imageConfirmation={composer.imageConfirmation}
        onDraftEdited={composer.clearImageConfirmation}
        onOpenModels={() => {
          // A group's failed run belongs to one member; change that bot's model.
          const failedBotId =
            inGroup && composer.displayedRunError ? activeSnapshot?.run?.botId : null;
          if (active && !inGroup) {
            setPanel("settings");
            setModelFocusRequest(Date.now());
          } else if (failedBotId) {
            openChatSettings("bot", failedBotId);
            setModelFocusRequest(Date.now());
          } else openSettings("models");
        }}
        onOpenConnections={() => openSettings("models")}
        onOpenBilling={() => openSettings("billing")}
        runError={composer.displayedRunError}
        runErrorId={composer.displayedRunErrorId}
        onRunErrorPresented={composer.handleRunErrorPresented}
        onDismissError={composer.dismissComposerError}
        onRetryRun={composer.retryRun}
        sending={composer.sending}
        fileInputRef={composer.fileInputRef}
        onAttachmentPick={composer.onAttachmentPick}
        onRemoveAttachment={composer.removeAttachment}
        onSend={composer.sendMessage}
        onStop={composer.stopRun}
        phoneCallsEnabled={phoneCallsEnabled}
        dictationTranscribe={dictationTranscribe}
        artifactTarget={artifactTarget}
        replyTarget={replyTarget}
        replyQuote={composer.replyQuote}
        replyTargetName={replyTargetName}
        onClearReply={composer.clearReply}
        mentionTargets={mentionTargets}
        agentSkills={agentSkills}
        onSlashOpen={onSlashOpen}
        onSlashAction={(action) => {
          if (action === "chat-settings") {
            setPanel(inGroup ? "group-settings" : "settings");
            return;
          }
          if (action === "settings-general") {
            openSettings("general");
            return;
          }
          if (action === "settings-usage") {
            openSettings("usage");
          }
        }}
      />
    </div>
  );
}
