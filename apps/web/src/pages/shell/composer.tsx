import { useLingui } from "@lingui/react/macro";
import type { AgentSkillCatalogEntry, ThreadMessage } from "@rakazo/contracts";
import type { ComposerMention, ComposerMentionRange, SlashActionId } from "@rakazo/core";
import {
  bindComposerMention,
  clampMentionHighlightIndex,
  composerMentionQuery,
  composerMentionsForPrompt,
  composerSelectedMentions,
  mentionChipKey,
  newClientId,
  replyAttachment,
  resolveComposerMentionEdit,
  resolveMentionPickerKey,
  SLASH_ACTIONS,
  serializeComposerPrompt,
  truncateSlashDescription,
  updateComposerMentionBindings,
} from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { ArrowUp, Box, Paperclip, Plus, Settings, Square, X } from "lucide-react";
import type { ClipboardEvent, DragEvent, RefObject } from "react";
import { memo, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  HoldToTalkControls,
  HoldToTalkStrip,
  useHoldToTalk,
} from "../../components/composer/HoldToTalk";
import type { ArtifactTarget } from "../../lib/artifact-open";
import { attachmentPickerAccept } from "../../lib/attachment-picker-accept";
import { useCallSession } from "../../lib/call-session";
import {
  beginComposerDraftSubmission,
  readComposerDraft,
  readComposerDraftBindings,
  settleComposerDraftSubmission,
  subscribeComposerDraftAccepted,
  writeComposerDraft,
} from "../../lib/composer-draft";
import { isFileDrag, isFilePaste } from "../../lib/pending-attachments";
import { ComposerReplyPreview } from "./chat-context";
import type { PendingAttachment } from "./chat-shared";
import { previewMessageText } from "./chat-shared";
import { ComposerError } from "./composer-error";
import {
  ComposerChip,
  ComposerMentionHighlights,
  MentionOptionIcon,
  slashActionLabel,
} from "./composer-mentions";
import { useComposerLayout } from "./use-composer-layout";

const ATTACHMENT_ACCEPT = attachmentPickerAccept(navigator.userAgent);
const COMPOSER_TEXT = "rk-scroll whitespace-pre-wrap break-words px-0.5 py-0.5 text-body1";
export const Composer = memo(function Composer({
  artifactTarget,
  activeName,
  running,
  disabled,
  pendingAttachments,
  attachmentNotice,
  sendError,
  imageConfirmation,
  onDraftEdited,
  onOpenModels,
  onOpenConnections,
  runError,
  runErrorId,
  onRunErrorPresented,
  onDismissError,
  sending,
  fileInputRef,
  onAttachmentPick,
  onRemoveAttachment,
  onSend,
  onStop,
  phoneCallsEnabled,
  dictationTranscribe,
  replyTarget,
  replyQuote,
  replyTargetName,
  onClearReply,
  mentionTargets,
  agentSkills,
  onSlashOpen,
  onSlashAction,
  draftKey,
  enterToSend,
}: {
  activeName?: string;
  running: boolean;
  disabled?: boolean;
  pendingAttachments: PendingAttachment[];
  attachmentNotice: string | null;
  sendError: string | null;
  imageConfirmation?: boolean;
  onDraftEdited?: () => void;
  onOpenModels: () => void;
  onOpenConnections: () => void;
  runError: string | null;
  runErrorId: string | null;
  onRunErrorPresented: (runId: string) => void;
  onDismissError: () => void;
  sending: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  onAttachmentPick: (files: FileList | readonly File[] | null) => boolean;
  onRemoveAttachment: (attachment: PendingAttachment) => void;
  onSend: (
    text: string,
    mentions: ComposerMention[],
    clientNonce: string,
    imageHandling?: "file",
  ) => Promise<boolean>;
  onStop: () => Promise<void>;
  phoneCallsEnabled?: boolean;
  /** Hold-to-talk falls back to the voice provider's transcription; undefined while unknown. */
  dictationTranscribe?: boolean;
  artifactTarget: ArtifactTarget;
  replyTarget?: ThreadMessage | null;
  replyQuote?: string | null;
  replyTargetName?: string;
  onClearReply?: () => void;
  mentionTargets?: ComposerMention[];
  agentSkills?: AgentSkillCatalogEntry[];
  onSlashOpen?: () => void;
  onSlashAction?: (action: SlashActionId) => void;
  draftKey: string;
  enterToSend: boolean;
}) {
  const { t } = useLingui();
  const [composition, setComposition] = useState(() => ({
    text: readComposerDraft(draftKey),
    bindings: readComposerDraftBindings(draftKey),
  }));
  const draft = composition.text;
  const mentionBindings = composition.bindings;
  const compositionRef = useRef(composition);
  compositionRef.current = composition;
  const selectedMentions = useMemo(
    () => composerSelectedMentions(mentionBindings),
    [mentionBindings],
  );
  const editSelections = useRef<ComposerMentionRange[]>([]);
  function rememberSelection(field: HTMLTextAreaElement) {
    editSelections.current = [
      { start: field.selectionStart, end: field.selectionEnd },
      ...editSelections.current,
    ].slice(0, 3);
  }
  function commitComposition(next: typeof composition, persist = true) {
    compositionRef.current = next;
    setComposition(next);
    editSelections.current = [];
    if (persist) writeComposerDraft(draftKey, next.text, undefined, next.bindings);
  }
  function appendDictation(text: string) {
    if (!mountedRef.current || draftKeyRef.current !== draftKey) return;
    const current = compositionRef.current.text;
    editSelections.current = [{ start: current.length, end: current.length }];
    updateDraft(current ? `${current} ${text}` : text);
  }
  const [mentionQuery, setMentionQuery] = useState<string | null>(
    () =>
      composerMentionQuery(draft, draft.length, draft.length, mentionTargets, mentionBindings)
        ?.query ?? null,
  );
  const [mentionHighlightKey, setMentionHighlightKey] = useState<string | null>(null);
  const [slashQuery, setSlashQuery] = useState<string | null>(() => {
    const slashMatch = /^\/([^\n]*)$/.exec(draft);
    return slashMatch ? (slashMatch[1] ?? "") : null;
  });
  const onCall = useCallSession() !== null;
  const talk = useHoldToTalk({
    transcribe: dictationTranscribe,
    disabled: disabled || onCall || !phoneCallsEnabled,
    onText: (text) => {
      // A refused send keeps the words: they land in the field to edit or retry.
      void onSend(text, [], newClientId())
        .then((accepted) => {
          if (accepted === false) appendDictation(text);
        })
        .catch(() => appendDictation(text));
    },
  });
  const [selectedSkill, setSelectedSkill] = useState<AgentSkillCatalogEntry | null>(null);
  const editRevision = useRef(0);
  useEffect(
    () =>
      subscribeComposerDraftAccepted(draftKey, (text) => {
        if (compositionRef.current.text === text)
          commitComposition({ text: "", bindings: [] }, false);
        setMentionQuery(null);
        setSlashQuery(null);
      }),
    [draftKey],
  );
  const retryNonce = useRef<string | null>(null);
  const replyId = replyTarget?.id ?? null;
  const quote = replyTarget ? (replyQuote ?? null) : null;
  const previousReply = useRef({ id: replyId, quote });
  useEffect(() => {
    if (previousReply.current.id !== replyId || previousReply.current.quote !== quote) {
      editRevision.current += 1;
      retryNonce.current = null;
      previousReply.current = { id: replyId, quote };
      onDraftEdited?.();
    }
  }, [replyId, quote, onDraftEdited]);
  const {
    textareaRef,
    mirrorRef,
    attachButtonRef,
    composerActionsRef,
    composerBarRef,
    composerFieldRef,
    expanded,
  } = useComposerLayout(draft, selectedSkill !== null);
  const pendingCaret = useRef<ComposerMentionRange | null>(null);
  const completedSelection = useRef<number | null>(null);
  useLayoutEffect(() => {
    if (pendingCaret.current === null) return;
    const selection = pendingCaret.current;
    pendingCaret.current = null;
    completedSelection.current = selection.start === selection.end ? selection.start : null;
    textareaRef.current?.setSelectionRange(selection.start, selection.end);
    textareaRef.current?.focus();
  });
  const [replyAnnouncement, setReplyAnnouncement] = useState("");
  // What the live region currently holds — a send disarming the reply clears
  // "reply" text, while an explicit cancel must keep "Reply cancelled".
  const replyAnnouncementKind = useRef<"reply" | "cancelled" | null>(null);
  const prevReplyTarget = useRef<ThreadMessage | null>(null);
  const mentionListboxId = useId();
  const dragDepth = useRef(0);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const [fileDragActive, setFileDragActive] = useState(false);
  useEffect(() => {
    // The transparent padding passes ordinary clicks through, but remains a file drop target.
    let depth = 0;
    const enter = (event: globalThis.DragEvent) => {
      if (!isFileDrag(event.dataTransfer)) return;
      depth += 1;
      setFileDragActive(true);
    };
    const finish = () => {
      depth = 0;
      dragDepth.current = 0;
      setFileDragActive(false);
      setDraggingFiles(false);
    };
    const leave = () => {
      depth = Math.max(0, depth - 1);
      if (depth === 0) finish();
    };
    window.addEventListener("dragenter", enter);
    window.addEventListener("dragleave", leave);
    window.addEventListener("drop", finish);
    window.addEventListener("dragend", finish);
    return () => {
      window.removeEventListener("dragenter", enter);
      window.removeEventListener("dragleave", leave);
      window.removeEventListener("drop", finish);
      window.removeEventListener("dragend", finish);
    };
  }, []);
  const canSend =
    draft.trim().length > 0 || selectedSkill !== null || pendingAttachments.length > 0;

  function markEdited() {
    onDraftEdited?.();
    editRevision.current += 1;
    retryNonce.current = null;
  }

  const draftKeyRef = useRef(draftKey);
  draftKeyRef.current = draftKey;
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  function pickAttachments(files: FileList | readonly File[] | null) {
    if (!files?.length) return;
    if (onAttachmentPick(files)) markEdited();
  }

  const knownMentions = [...(mentionTargets ?? []), ...selectedMentions];

  function updateDraft(
    nativeValue: string,
    nativeCaret = nativeValue.length,
    nativeEnd = nativeCaret,
    composing = false,
  ) {
    markEdited();
    const current = compositionRef.current;
    const hints = {
      before: editSelections.current,
      after: { start: nativeCaret, end: nativeEnd },
    };
    const edit = composing
      ? {
          text: nativeValue,
          bindings: updateComposerMentionBindings(
            current.text,
            nativeValue,
            current.bindings,
            hints,
          ),
          caret: null,
        }
      : resolveComposerMentionEdit(current.text, nativeValue, current.bindings, hints);
    const value = edit.text;
    const caret = edit.caret ?? nativeCaret;
    const end = edit.caret ?? nativeEnd;
    if (edit.caret !== null) pendingCaret.current = { start: caret, end };
    commitComposition({ text: value, bindings: edit.bindings });
    setMentionQuery(
      composerMentionQuery(value, caret, end, knownMentions, edit.bindings)?.query ?? null,
    );
    // `/` only at the start of the draft so forced skills expand (`Use skill:` / `/Name` prefix).
    const slashMatch = selectedSkill === null ? /^\/([^\n]*)$/.exec(value) : null;
    const nextSlash = slashMatch ? (slashMatch[1] ?? "") : null;
    if (nextSlash !== null && slashQuery === null) onSlashOpen?.();
    setSlashQuery(nextSlash);
  }

  function insertMention(mention: ComposerMention) {
    const field = textareaRef.current;
    if (!field) return;
    const query = composerMentionQuery(
      draft,
      field.selectionStart,
      field.selectionEnd,
      knownMentions,
      mentionBindings,
    );
    if (!query || query.query !== mentionQuery) return;
    markEdited();
    const completion = bindComposerMention(draft, query, mention, mentionBindings);
    commitComposition({ text: completion.text, bindings: completion.bindings });
    setMentionQuery(null);
    setMentionHighlightKey(null);
    // Restore after React has committed the new controlled value.
    pendingCaret.current = { start: completion.caret, end: completion.caret };
  }

  function insertSkill(skill: AgentSkillCatalogEntry) {
    markEdited();
    setSelectedSkill(skill);
    commitComposition({ text: "", bindings: [] });
    setSlashQuery(null);
  }

  function runSlashAction(action: SlashActionId) {
    markEdited();
    commitComposition({ text: "", bindings: [] });
    setSlashQuery(null);
    onSlashAction?.(action);
  }

  function removeSkill() {
    markEdited();
    setSelectedSkill(null);
  }

  const mentionOptions = useMemo(() => {
    if (mentionQuery === null || !mentionTargets?.length) return [];
    const query = mentionQuery.trim().toLowerCase();
    return mentionTargets
      .filter((target) => !query || target.name.toLowerCase().startsWith(query))
      .slice(0, 10);
  }, [mentionQuery, mentionTargets]);

  useEffect(() => {
    setMentionHighlightKey(null);
  }, [mentionQuery]);

  const activeMentionIndex = clampMentionHighlightIndex(
    mentionOptions.findIndex((mention) => mentionChipKey(mention) === mentionHighlightKey),
    mentionOptions.length,
  );
  const mentionPickerOpen = mentionOptions.length > 0;
  const activeMentionOptionId = mentionPickerOpen
    ? `${mentionListboxId}-option-${activeMentionIndex}`
    : undefined;

  const slashSkillOptions = useMemo(() => {
    if (slashQuery === null) return [];
    const query = slashQuery.trim().toLowerCase();
    const skills = agentSkills ?? [];
    return skills
      .filter((skill) => {
        if (!query) return true;
        return (
          skill.name.toLowerCase().includes(query) ||
          skill.description.toLowerCase().includes(query)
        );
      })
      .slice(0, 8);
  }, [agentSkills, slashQuery]);

  const slashActionOptions = useMemo(() => {
    if (slashQuery === null) return [];
    const query = slashQuery.trim().toLowerCase();
    return SLASH_ACTIONS.filter((action) => !query || action.label.toLowerCase().includes(query));
  }, [slashQuery]);

  const showSlashPicker =
    slashQuery !== null &&
    mentionQuery === null &&
    (slashSkillOptions.length > 0 || slashActionOptions.length > 0);

  async function send(imageHandling?: "file") {
    if (!canSend || sending || disabled) return;
    const revision = editRevision.current;
    const clientNonce = retryNonce.current ?? newClientId();
    retryNonce.current = null;
    const submitted = compositionRef.current;
    const text = serializeComposerPrompt(submitted.text, selectedSkill);
    const mentions = composerMentionsForPrompt(submitted.text, selectedSkill, submitted.bindings);
    const submission = beginComposerDraftSubmission(draftKey, draft);
    commitComposition({ text: "", bindings: [] }, false);
    setMentionQuery(null);
    setMentionHighlightKey(null);
    setSlashQuery(null);
    setSelectedSkill(null);
    try {
      const accepted =
        (await (imageHandling
          ? onSend(text, mentions, clientNonce, imageHandling)
          : onSend(text, mentions, clientNonce))) !== false;
      settleComposerDraftSubmission(draftKey, submission, accepted);
      if (accepted) return;
    } catch {
      settleComposerDraftSubmission(draftKey, submission, false);
      // A rejected callback leaves acceptance unknown; do not restore a possible send.
      return;
    }
    // Restore only an untouched draft, retaining its nonce for an unchanged retry.
    if (editRevision.current !== revision) return;
    retryNonce.current = clientNonce;
    commitComposition(submitted, false);
    setSelectedSkill(selectedSkill);
  }

  function handleDragEnter(event: DragEvent<HTMLFieldSetElement>) {
    const dataTransfer = event.dataTransfer;
    if (!isFileDrag(dataTransfer)) return;
    event.preventDefault();
    if (disabled) {
      dragDepth.current = 0;
      setDraggingFiles(false);
      return;
    }
    dragDepth.current += 1;
    setDraggingFiles(true);
  }

  function handleDragOver(event: DragEvent<HTMLFieldSetElement>) {
    const dataTransfer = event.dataTransfer;
    if (!isFileDrag(dataTransfer)) return;
    event.preventDefault();
    dataTransfer.dropEffect = disabled ? "none" : "copy";
    if (disabled) {
      dragDepth.current = 0;
      setDraggingFiles(false);
      return;
    }
    setDraggingFiles(true);
  }

  function handleDragLeave(event: DragEvent<HTMLFieldSetElement>) {
    if (!isFileDrag(event.dataTransfer)) return;
    if (disabled) {
      dragDepth.current = 0;
      setDraggingFiles(false);
      return;
    }
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDraggingFiles(false);
  }

  function handleDrop(event: DragEvent<HTMLFieldSetElement>) {
    const dataTransfer = event.dataTransfer;
    if (!isFileDrag(dataTransfer)) return;
    event.preventDefault();
    dragDepth.current = 0;
    setDraggingFiles(false);
    if (!disabled) pickAttachments(dataTransfer.files);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const clipboardData = event.clipboardData;
    // Only intercept real FileList pastes; leave text-only / empty-files native.
    if (disabled || !clipboardData || !isFilePaste(clipboardData)) return;
    event.preventDefault();
    pickAttachments(clipboardData.files);
    const text = clipboardData.getData("text/plain");
    if (!text) return;
    const textarea = event.currentTarget;
    const start = textarea.selectionStart;
    const end = textarea.selectionEnd;
    rememberSelection(textarea);
    updateDraft(`${draft.slice(0, start)}${text}${draft.slice(end)}`, start + text.length);
    const caret = start + text.length;
    window.requestAnimationFrame(() => {
      textareaRef.current?.setSelectionRange(caret, caret);
    });
  }

  const showComposerPlaceholder = draft.length === 0 && selectedSkill === null;

  const replyName = replyTarget ? (replyTargetName ?? previewMessageText(replyTarget)) : "";
  const replyNameRef = useRef(replyName);
  replyNameRef.current = replyName;
  const announceTimer = useRef(0);
  useEffect(() => () => window.clearTimeout(announceTimer.current), []);

  // Arming or retargeting a reply unmounts the control that started it, so
  // focus would drop to <body>; announce on start and when the target changes.
  // The timer lives in a ref: a same-id rerender (e.g. the display name
  // resolving after arming) must not cancel the pending announcement.
  useEffect(() => {
    const prev = prevReplyTarget.current;
    prevReplyTarget.current = replyTarget ?? null;
    if (!replyTarget) {
      // Cancel (or send) within the delay must not let a stale "Replying to"
      // overwrite the cancel announcement — kill the pending timer.
      window.clearTimeout(announceTimer.current);
      // A send disarms the reply without touching the region — drop the stale
      // "Replying to" so it cannot linger or re-announce. An explicit cancel
      // sets "Reply cancelled" in the same event, so only clear "reply" text.
      if (replyAnnouncementKind.current === "reply") {
        replyAnnouncementKind.current = null;
        setReplyAnnouncement("");
      }
      return;
    }
    if (!prev || prev.id !== replyTarget.id) {
      textareaRef.current?.focus();
      // Clear-then-set so a switch between same-author targets re-announces —
      // identical live-region text would otherwise be a no-op.
      setReplyAnnouncement("");
      replyAnnouncementKind.current = null;
      window.clearTimeout(announceTimer.current);
      announceTimer.current = window.setTimeout(() => {
        replyAnnouncementKind.current = "reply";
        setReplyAnnouncement(t`Replying to ${replyNameRef.current}`);
      }, 50);
    }
  }, [replyTarget, replyName, t]);

  return (
    <fieldset
      aria-label={t`Message composer`}
      data-dragging={draggingFiles ? "files" : undefined}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      className={`relative z-30 m-0 min-w-0 border-0 px-3 pb-4 pt-0 md:px-[max(1.5rem,calc((100%_-_60rem)/2))] md:pb-6 [&>*]:pointer-events-auto ${fileDragActive ? "pointer-events-auto" : "pointer-events-none"} ${
        draggingFiles ? "rounded-[14px] ring-2 ring-inset ring-ring" : ""
      }`}
    >
      <div role="status" data-testid="composer-announcement" className="sr-only">
        {replyAnnouncement}
      </div>
      <ComposerError
        sendError={sendError}
        imageConfirmation={imageConfirmation}
        onSendAsFile={imageConfirmation && !sending ? () => void send("file") : undefined}
        runError={runError}
        runErrorId={runErrorId}
        onRunErrorPresented={onRunErrorPresented}
        onOpenModels={onOpenModels}
        onOpenConnections={onOpenConnections}
        onDismissError={onDismissError}
        textareaRef={textareaRef}
      />
      {replyTarget ? (
        <ComposerReplyPreview
          author={replyName}
          text={previewMessageText(replyTarget)}
          quote={replyQuote}
          attachment={replyAttachment(replyTarget.blocks)}
          target={artifactTarget}
          onDismiss={() => {
            replyAnnouncementKind.current = "cancelled";
            window.clearTimeout(announceTimer.current);
            onClearReply?.();
            setReplyAnnouncement(t`Reply cancelled`);
            textareaRef.current?.focus();
          }}
        />
      ) : null}
      {attachmentNotice ? (
        <div className="mb-3 rounded-[14px] border border-warning/40 bg-warning/10 px-4 py-2 text-[13px] text-warning">
          {attachmentNotice}
        </div>
      ) : null}
      {pendingAttachments.length ? (
        <div className="mb-3 flex flex-wrap gap-2">
          {pendingAttachments.map((attachment) => (
            <div
              key={attachment.id}
              className="flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1.5 text-[13px] text-foreground/75"
            >
              {attachment.previewUrl ? (
                <img
                  src={attachment.previewUrl}
                  alt={attachment.file.name}
                  className="h-8 w-8 rounded object-cover"
                />
              ) : (
                <Paperclip size={14} strokeWidth={1.8} />
              )}
              <span className="max-w-[180px] truncate" dir="auto">
                {attachment.file.name}
              </span>
              <button
                type="button"
                aria-label={t`Remove ${attachment.file.name}`}
                onClick={() => {
                  markEdited();
                  onRemoveAttachment(attachment);
                }}
                className="text-muted-foreground hover:text-foreground"
              >
                <X size={13} strokeWidth={2} />
              </button>
            </div>
          ))}
        </div>
      ) : null}
      {mentionPickerOpen ? (
        <div
          id={mentionListboxId}
          role="listbox"
          aria-label={t`Mentions`}
          data-testid="mention-picker"
          className="mb-2 overflow-hidden rounded-[14px] border border-border bg-muted animate-in fade-in-0 slide-in-from-bottom-1 duration-150 motion-reduce:animate-none"
        >
          {mentionOptions.map((mention, index) => {
            const optionId = `${mentionListboxId}-option-${index}`;
            const highlighted = index === activeMentionIndex;
            return (
              <button
                id={optionId}
                key={mentionChipKey(mention)}
                type="button"
                role="option"
                aria-selected={highlighted}
                aria-label={t`@${mention.name}`}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => insertMention(mention)}
                // Opening the list under a stationary pointer must not steal the keyboard highlight.
                onMouseMove={() => setMentionHighlightKey(mentionChipKey(mention))}
                className={`flex w-full items-start gap-3 px-4 py-2.5 text-start hover:bg-accent ${
                  highlighted ? "bg-accent" : ""
                }`}
              >
                <MentionOptionIcon mention={mention} />
                <span className="min-w-0">
                  <span dir="auto" className="block text-[14px] text-foreground">
                    @{mention.name}
                  </span>
                  {mention.subtitle ? (
                    <span dir="auto" className="block truncate text-[12.5px] text-muted-foreground">
                      {mention.subtitle}
                    </span>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}
      {showSlashPicker ? (
        <div
          data-testid="slash-picker"
          className="mb-2 overflow-hidden rounded-[14px] border border-border bg-muted"
        >
          {slashSkillOptions.map((skill) => (
            <button
              key={skill.id}
              type="button"
              aria-label={t`Skill ${skill.name}`}
              onClick={() => insertSkill(skill)}
              className="flex w-full items-start gap-3 px-4 py-2.5 text-start hover:bg-accent"
            >
              <Box size={16} strokeWidth={1.7} className="mt-0.5 shrink-0 text-muted-foreground" />
              <span className="min-w-0">
                <span dir="auto" className="block text-[14px] text-foreground">
                  {skill.name}
                </span>
                <span dir="auto" className="block truncate text-[12.5px] text-muted-foreground">
                  {truncateSlashDescription(skill.description)}
                </span>
              </span>
            </button>
          ))}
          {slashActionOptions.map((action) => {
            const label = slashActionLabel(action.id);
            return (
              <button
                key={action.id}
                type="button"
                aria-label={label}
                onClick={() => runSlashAction(action.id)}
                className="flex w-full items-center gap-3 px-4 py-2.5 text-start hover:bg-accent"
              >
                <Settings size={16} strokeWidth={1.7} className="shrink-0 text-muted-foreground" />
                <span className="text-[14px] text-foreground">{label}</span>
              </button>
            );
          })}
        </div>
      ) : null}
      <div
        ref={composerBarRef}
        data-testid="composer-bar"
        data-expanded={expanded}
        className={`grid grid-cols-[auto_minmax(0,1fr)_auto] content-end items-center rounded-[26px] border border-border bg-background pe-2.5 ps-3 transition-colors focus-within:border-input ${
          expanded ? "gap-x-2 gap-y-2 pb-[9px] pt-3" : "gap-x-3.5 py-[9px]"
        }`}
      >
        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          className="hidden"
          onChange={(event) => pickAttachments(event.target.files)}
        />
        <Button
          ref={attachButtonRef}
          variant="ghost"
          size="icon"
          aria-label={t`Attach file`}
          disabled={disabled}
          onClick={() => fileInputRef.current?.click()}
          className={`col-start-1 size-8 shrink-0 rounded-full border border-border bg-muted text-muted-foreground transition-colors hover:bg-accent hover:text-foreground ${
            expanded ? "row-start-2" : ""
          }`}
        >
          <Plus size={16} strokeWidth={2} />
        </Button>
        <div
          ref={composerFieldRef}
          data-testid="composer-field"
          className={`flex min-w-0 flex-wrap items-end gap-1.5 ${
            expanded ? "col-span-3 row-start-1 px-1.5" : "col-start-2"
          }`}
        >
          {selectedSkill ? (
            <ComposerChip
              data-testid="skill-chip"
              icon={
                <Box size={13} strokeWidth={1.7} className="shrink-0 text-muted-foreground/70" />
              }
              label={selectedSkill.name}
              removeLabel={t`Remove skill ${selectedSkill.name}`}
              onRemove={removeSkill}
            />
          ) : null}
          <HoldToTalkStrip talk={talk} />
          <div className="relative min-w-[8rem] flex-1" hidden={talk.recording !== null}>
            <textarea
              ref={textareaRef}
              value={draft}
              onChange={(event) => {
                completedSelection.current = null;
                updateDraft(
                  event.target.value,
                  event.target.selectionStart,
                  event.target.selectionEnd,
                  (event.nativeEvent as InputEvent).isComposing,
                );
              }}
              onBeforeInput={(event) => rememberSelection(event.currentTarget)}
              onSelect={(event) => {
                const field = event.currentTarget;
                if (pendingCaret.current !== null) return;
                rememberSelection(field);
                if (
                  completedSelection.current === field.selectionStart &&
                  field.selectionStart === field.selectionEnd
                )
                  return;
                completedSelection.current = null;
                setMentionQuery(
                  composerMentionQuery(
                    field.value,
                    field.selectionStart,
                    field.selectionEnd,
                    knownMentions,
                    mentionBindings,
                  )?.query ?? null,
                );
              }}
              onPaste={handlePaste}
              onKeyDown={(event) => {
                rememberSelection(event.currentTarget);
                if (event.key === "Backspace" && draft.length === 0 && selectedSkill !== null) {
                  event.preventDefault();
                  removeSkill();
                  return;
                }
                const action = resolveMentionPickerKey({
                  key: event.key,
                  shiftKey: event.shiftKey,
                  ctrlKey: event.ctrlKey,
                  metaKey: event.metaKey,
                  enterToSend,
                  isComposing: event.nativeEvent.isComposing || event.keyCode === 229,
                  optionCount: mentionOptions.length,
                  highlightedIndex: activeMentionIndex,
                });
                if (action.type === "complete") {
                  const mention = mentionOptions[action.index];
                  if (!mention) return;
                  event.preventDefault();
                  insertMention(mention);
                  return;
                }
                if (action.type === "move") {
                  event.preventDefault();
                  setMentionHighlightKey(mentionChipKey(mentionOptions[action.index]!));
                  return;
                }
                if (action.type === "dismiss") {
                  event.preventDefault();
                  completedSelection.current = event.currentTarget.selectionStart;
                  setMentionQuery(null);
                  setMentionHighlightKey(null);
                  return;
                }
                if (action.type === "send") {
                  event.preventDefault();
                  void send();
                }
              }}
              disabled={disabled}
              placeholder={
                showComposerPlaceholder
                  ? activeName
                    ? t`Message ${activeName}`
                    : t`Message…`
                  : undefined
              }
              aria-label={activeName ? t`Message ${activeName}` : t`Message`}
              role="combobox"
              aria-autocomplete="list"
              aria-haspopup="listbox"
              aria-expanded={mentionPickerOpen}
              aria-controls={mentionPickerOpen ? mentionListboxId : undefined}
              aria-activedescendant={activeMentionOptionId}
              name="chat-message"
              autoComplete="off"
              dir="auto"
              rows={1}
              className={`${COMPOSER_TEXT} block max-h-25 min-h-[24px] w-full resize-none overflow-y-auto bg-transparent text-transparent caret-foreground outline-none placeholder:text-muted-foreground selection:bg-ring/30 selection:text-transparent disabled:opacity-40 forced-colors:text-[CanvasText]`}
            />
            <ComposerMentionHighlights
              ref={mirrorRef}
              text={draft}
              bindings={mentionBindings}
              targets={mentionTargets ?? []}
              className={`${COMPOSER_TEXT} pointer-events-none absolute inset-0 overflow-y-hidden text-foreground [unicode-bidi:plaintext] forced-colors:hidden ${disabled ? "opacity-40" : ""}`}
            />
          </div>
        </div>
        <div
          ref={composerActionsRef}
          className={`col-start-3 flex shrink-0 items-center gap-2 justify-self-end ${
            expanded ? "row-start-2" : ""
          }`}
        >
          {talk.recording?.locked ? (
            <HoldToTalkControls talk={talk} />
          ) : running ? (
            <>
              {phoneCallsEnabled && draft.trim().length === 0 ? (
                <HoldToTalkControls talk={talk} disabled={disabled || onCall} />
              ) : null}
              <Button
                size="icon"
                aria-label={t`Send`}
                disabled={sending || !canSend || disabled}
                onClick={() => void send()}
                className="size-8 shrink-0 rounded-full transition-transform active:scale-95 disabled:bg-primary-disabled disabled:text-foreground/30 disabled:opacity-100"
              >
                <ArrowUp size={16} strokeWidth={2.2} />
              </Button>
              <Button
                variant="outline"
                size="icon"
                aria-label={t`Stop`}
                disabled={sending}
                onClick={() => void onStop()}
                className="size-8 rounded-full border border-border bg-muted text-foreground/80 shadow-sm transition-colors hover:bg-accent hover:text-foreground"
              >
                <Square size={11} strokeWidth={0} fill="currentColor" />
              </Button>
            </>
          ) : (
            <>
              {phoneCallsEnabled && draft.trim().length === 0 ? (
                <HoldToTalkControls talk={talk} disabled={disabled || onCall} />
              ) : null}
              <Button
                size="icon"
                aria-label={t`Send`}
                disabled={sending || !canSend || disabled}
                onClick={() => void send()}
                className="size-8 shrink-0 rounded-full transition-transform active:scale-95 disabled:bg-primary-disabled disabled:text-foreground/30 disabled:opacity-100"
              >
                <ArrowUp size={16} strokeWidth={2.2} />
              </Button>
            </>
          )}
        </div>
      </div>
    </fieldset>
  );
});
