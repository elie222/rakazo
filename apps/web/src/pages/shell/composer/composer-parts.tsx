import { useLingui } from "@lingui/react/macro";
import type { AgentSkillCatalogEntry } from "@rakazo/contracts";
import type { ComposerMention, SLASH_ACTIONS, SlashActionId } from "@rakazo/core";
import { mentionChipKey, resolveMentionPickerKey, truncateSlashDescription } from "@rakazo/core";
import { Button } from "@rakazo/ui-web";
import { ArrowUp, Box, Paperclip, Settings, Square, X } from "lucide-react";
import type { ClipboardEvent, CSSProperties, KeyboardEvent, ReactNode, RefObject } from "react";
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import * as composerDraft from "../../../lib/composer/composer-draft";
import { isFilePaste } from "../../../lib/composer/pending-attachments";
import { usePageSession } from "../../../lib/pages/pages";
import { hasOpenDialog } from "../../../lib/platform/has-open-dialog";
import { useEventListener } from "../../../lib/use-event-listener";
import type { PendingAttachment } from "../chat/chat-shared";
import { isApplePlatform, isEditableTarget, primaryModifier } from "../shell-shortcuts";
import { MentionOptionIcon, slashActionLabel } from "./composer-mentions";
import type { useHoldToTalk } from "./hold-to-talk";
import { HoldToTalkControls } from "./hold-to-talk";

/** The files waiting to go with the next message, each with its remove button. */
export function PendingAttachmentChips({
  attachments,
  onRemove,
}: {
  attachments: PendingAttachment[];
  onRemove: (attachment: PendingAttachment) => void;
}) {
  const { t } = useLingui();
  if (!attachments.length) return null;
  return (
    <div className="mb-3 flex flex-wrap gap-2">
      {attachments.map((attachment) => (
        <div
          key={attachment.id}
          className="flex items-center gap-2 rounded-full border border-border bg-muted px-3 py-1.5 text-body-sm text-foreground/75"
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
            onClick={() => onRemove(attachment)}
            className="text-muted-foreground hover:text-foreground"
          >
            <X size={13} strokeWidth={2} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The `@` list; the message field keeps focus and points at the highlighted option. */
export function MentionPicker({
  listboxId,
  options,
  activeIndex,
  onPick,
  onHighlight,
}: {
  listboxId: string;
  options: ComposerMention[];
  activeIndex: number;
  onPick: (mention: ComposerMention) => void;
  onHighlight: (mention: ComposerMention) => void;
}) {
  const { t } = useLingui();
  // Options sharing a name are told apart by their kind and visible subtitle. Bot and group
  // subtitles already name their kind; routine and connector subtitles do not.
  const nameCounts = new Map<string, number>();
  for (const { name } of options) nameCounts.set(name, (nameCounts.get(name) ?? 0) + 1);
  const kindLabels: Partial<Record<ComposerMention["kind"], string>> = {
    routine: t`Routine`,
    connector: t`Connector`,
  };
  return (
    <div
      id={listboxId}
      role="listbox"
      aria-label={t`Mentions`}
      data-testid="mention-picker"
      className="mb-2 overflow-hidden rounded-[14px] border border-border bg-muted animate-in fade-in-0 slide-in-from-bottom-1 duration-150 motion-reduce:animate-none"
    >
      {options.map((mention, index) => {
        const optionId = `${listboxId}-option-${index}`;
        const highlighted = index === activeIndex;
        const details =
          (nameCounts.get(mention.name) ?? 0) > 1
            ? [kindLabels[mention.kind], mention.subtitle].filter(Boolean).join(", ")
            : "";
        return (
          <button
            id={optionId}
            key={mentionChipKey(mention)}
            type="button"
            role="option"
            aria-selected={highlighted}
            aria-label={details ? t`@${mention.name}, ${details}` : t`@${mention.name}`}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(mention)}
            // Opening the list under a stationary pointer must not steal the keyboard highlight.
            onMouseMove={() => onHighlight(mention)}
            className={`flex w-full items-center gap-3 px-4 py-2.5 text-start hover:bg-accent ${
              highlighted ? "bg-accent" : ""
            }`}
          >
            <MentionOptionIcon mention={mention} />
            <span className="min-w-0">
              <span dir="auto" className="block text-body text-foreground">
                @{mention.name}
              </span>
              {mention.subtitle ? (
                <span dir="auto" className="block truncate text-body-sm text-muted-foreground">
                  {mention.subtitle}
                </span>
              ) : null}
            </span>
          </button>
        );
      })}
    </div>
  );
}

/** The `/` list: skills to attach, then actions to run. */
export function SlashPicker({
  listboxId,
  activeIndex,
  onHighlight,
  skills,
  actions,
  onSkill,
  onAction,
}: {
  listboxId: string;
  activeIndex: number;
  onHighlight: (key: string) => void;
  skills: AgentSkillCatalogEntry[];
  actions: ReadonlyArray<(typeof SLASH_ACTIONS)[number]>;
  onSkill: (skill: AgentSkillCatalogEntry) => void;
  onAction: (action: SlashActionId) => void;
}) {
  const { t } = useLingui();
  return (
    <div
      id={listboxId}
      role="listbox"
      aria-label={t`Command menu`}
      data-testid="slash-picker"
      className="mb-2 overflow-hidden rounded-[14px] border border-border bg-muted"
    >
      {skills.map((skill, index) => (
        <button
          id={`${listboxId}-option-${index}`}
          key={skill.id}
          type="button"
          role="option"
          aria-selected={index === activeIndex}
          aria-label={t`Skill ${skill.name}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSkill(skill)}
          onMouseMove={() => onHighlight(`skill:${skill.id}`)}
          className={`flex w-full items-center gap-3 px-4 py-2.5 text-start hover:bg-accent ${
            index === activeIndex ? "bg-accent" : ""
          }`}
        >
          <Box size={16} strokeWidth={1.7} className="shrink-0 text-muted-foreground" />
          <span className="min-w-0">
            <span dir="auto" className="block text-body text-foreground">
              {skill.name}
            </span>
            <span dir="auto" className="block truncate text-body-sm text-muted-foreground">
              {truncateSlashDescription(skill.description)}
            </span>
          </span>
        </button>
      ))}
      {actions.map((action, actionIndex) => {
        const label = slashActionLabel(action.id);
        const index = skills.length + actionIndex;
        return (
          <button
            id={`${listboxId}-option-${index}`}
            key={action.id}
            type="button"
            role="option"
            aria-selected={index === activeIndex}
            aria-label={label}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onAction(action.id)}
            onMouseMove={() => onHighlight(`action:${action.id}`)}
            className={`flex w-full items-center gap-3 px-4 py-2.5 text-start hover:bg-accent ${
              index === activeIndex ? "bg-accent" : ""
            }`}
          >
            <Settings size={16} strokeWidth={1.7} className="shrink-0 text-muted-foreground" />
            <span className="text-body text-foreground">{label}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Hold-to-talk, Send, and while a reply runs, Stop. */
export function ComposerActions({
  actionsRef,
  expanded,
  talk,
  running,
  showTalk,
  talkDisabled,
  sendDisabled,
  stopDisabled,
  sendColors,
  modelPicker,
  onSend,
  onStop,
}: {
  actionsRef: RefObject<HTMLDivElement | null>;
  expanded: boolean;
  talk: ReturnType<typeof useHoldToTalk>;
  running: boolean;
  /** Hold-to-talk shows beside Send while the draft is empty. */
  showTalk: boolean;
  talkDisabled: boolean;
  sendDisabled: boolean | undefined;
  stopDisabled: boolean;
  /** The bot's color, as your messages to it wear it; the send button matches them. */
  sendColors?: { background: string; foreground: string };
  modelPicker?: ReactNode;
  onSend: () => void;
  onStop: () => void;
}) {
  const { t } = useLingui();
  // The same chat-user colors your bubbles in this chat wear (set the same way in the transcript).
  const sendStyle = sendColors
    ? ({
        "--chat-user": sendColors.background,
        "--chat-user-foreground": sendColors.foreground,
      } as CSSProperties)
    : undefined;
  // An empty draft keeps the quiet disabled look either way; the bot's color shows once it can go.
  const sendClassName = `shrink-0 rounded-full transition-transform active:scale-95 disabled:bg-primary-disabled disabled:text-foreground/30 disabled:opacity-100 ${sendColors ? "bg-chat-user text-chat-user-foreground hover:bg-chat-user/90" : ""}`;
  return (
    <div
      ref={actionsRef}
      className={`col-start-3 flex shrink-0 items-center gap-2 justify-self-end ${
        expanded ? "row-start-2" : ""
      }`}
    >
      {talk.recording?.locked ? null : modelPicker}
      {talk.recording?.locked ? (
        <HoldToTalkControls talk={talk} />
      ) : running ? (
        <>
          {showTalk ? <HoldToTalkControls talk={talk} disabled={talkDisabled} /> : null}
          <Button
            size="icon"
            aria-label={t`Send`}
            disabled={sendDisabled}
            onClick={onSend}
            style={sendStyle}
            className={sendClassName}
          >
            <ArrowUp size={16} strokeWidth={2.2} />
          </Button>
          <Button
            variant="outline"
            size="icon"
            aria-label={t`Stop`}
            disabled={stopDisabled}
            onClick={onStop}
            className="rounded-full border border-border bg-muted text-foreground/80 shadow-sm transition-colors hover:bg-accent hover:text-foreground"
          >
            <Square size={11} strokeWidth={0} fill="currentColor" />
          </Button>
        </>
      ) : (
        <>
          {showTalk ? <HoldToTalkControls talk={talk} disabled={talkDisabled} /> : null}
          <Button
            size="icon"
            aria-label={t`Send`}
            disabled={sendDisabled}
            onClick={onSend}
            style={sendStyle}
            className={sendClassName}
          >
            <ArrowUp size={16} strokeWidth={2.2} />
          </Button>
        </>
      )}
    </div>
  );
}

const noDockState = { node: null, page: null };
export const noComposerDock = { subscribe: () => () => {}, get: () => noDockState };

/** Moves one mounted composer portal between the chat column and the open page dock. */
export function ComposerDockHost({ children }: { children: (docked: boolean) => ReactNode }) {
  const dock = usePageSession()?.dock ?? noComposerDock;
  const { node: dockNode } = useSyncExternalStore(dock.subscribe, dock.get);
  const [host] = useState(() => {
    const element = document.createElement("div");
    element.style.display = "contents";
    return element;
  });
  const slot = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const target = dockNode ?? slot.current;
    if (!target || host.parentNode === target) return;
    const focused = host.contains(document.activeElement) ? document.activeElement : null;
    target.append(host);
    if (focused instanceof HTMLElement) focused.focus({ preventScroll: true });
  }, [dockNode, host]);
  useEffect(() => () => host.remove(), [host]);
  return (
    <>
      <div ref={slot} className="contents" />
      {createPortal(children(dockNode !== null), host)}
    </>
  );
}

/** Cmd/Ctrl+D in the message field starts hands-free dictation, and submits it once locked. */
export function useDictationShortcut({
  talk,
  available,
  textareaRef,
}: {
  talk: ReturnType<typeof useHoldToTalk>;
  available: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const state = useRef({ talk, available });
  state.current = { talk, available };
  useEventListener(window, "keydown", (event) => {
    if (event.repeat || event.altKey || event.shiftKey || event.key?.toLowerCase() !== "d") return;
    if (!primaryModifier(event, isApplePlatform())) return;
    const current = state.current;
    if (current.talk.recording) {
      // Pressed while typing elsewhere, it belongs to that field rather than this recording.
      if (!current.talk.recording.locked || current.talk.transcribing) return;
      if (isEditableTarget(event.target) || hasOpenDialog(document)) return;
      event.preventDefault();
      current.talk.submit();
    } else if (current.available && document.activeElement === textareaRef.current) {
      event.preventDefault();
      current.talk.startHandsFree();
    }
  });
}

/** Handles composer textarea keyboard navigation, picker completion, send, and Escape stop. */
export function handleComposerKeyDown(
  event: KeyboardEvent<HTMLTextAreaElement>,
  params: {
    rememberSelection: (field: HTMLTextAreaElement) => void;
    draftLength: number;
    hasSkill: boolean;
    removeSkill: () => void;
    enterToSend: boolean;
    mentionPickerOpen: boolean;
    mentionOptions: ComposerMention[];
    activeMentionIndex: number;
    slashOptionKeys: string[];
    activeSlashIndex: number;
    showSlashPicker: boolean;
    pickSlashOption: (index: number) => void;
    setSlashHighlightKey: (key: string | null) => void;
    setCompletedSelection: (caret: number) => void;
    setSlashQuery: (query: null) => void;
    insertMention: (mention: ComposerMention) => void;
    setMentionHighlightKey: (key: string | null) => void;
    setMentionQuery: (query: null) => void;
    onSend: () => void;
    canStop: boolean;
    onStop: () => void;
  },
) {
  params.rememberSelection(event.currentTarget);
  if (event.key === "Backspace" && params.draftLength === 0 && params.hasSkill) {
    event.preventDefault();
    params.removeSkill();
    return;
  }
  const action = resolveMentionPickerKey({
    key: event.key,
    shiftKey: event.shiftKey,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    enterToSend: params.enterToSend,
    isComposing: event.nativeEvent.isComposing || event.keyCode === 229,
    optionCount: params.mentionPickerOpen
      ? params.mentionOptions.length
      : params.slashOptionKeys.length,
    highlightedIndex: params.mentionPickerOpen
      ? params.activeMentionIndex
      : params.activeSlashIndex,
  });
  // An open slash menu only sends once closed, so Ctrl/Cmd+Enter picks the row too.
  if (params.showSlashPicker && action.type !== "none") {
    event.preventDefault();
    if (action.type === "complete" || action.type === "send")
      params.pickSlashOption(params.activeSlashIndex);
    else if (action.type === "move")
      params.setSlashHighlightKey(params.slashOptionKeys[action.index] ?? null);
    else {
      params.setCompletedSelection(event.currentTarget.selectionStart);
      params.setSlashQuery(null);
    }
    return;
  }
  if (action.type === "complete") {
    const mention = params.mentionOptions[action.index];
    if (!mention) return;
    event.preventDefault();
    params.insertMention(mention);
    return;
  }
  if (action.type === "move") {
    event.preventDefault();
    params.setMentionHighlightKey(mentionChipKey(params.mentionOptions[action.index]!));
    return;
  }
  if (action.type === "dismiss") {
    event.preventDefault();
    params.setCompletedSelection(event.currentTarget.selectionStart);
    params.setMentionQuery(null);
    params.setMentionHighlightKey(null);
    return;
  }
  if (action.type === "send") {
    event.preventDefault();
    params.onSend();
    return;
  }
  if (
    event.key !== "Escape" ||
    event.repeat ||
    event.nativeEvent.isComposing ||
    event.keyCode === 229 ||
    event.shiftKey ||
    event.ctrlKey ||
    event.metaKey ||
    event.altKey
  )
    return;
  if (params.canStop) {
    event.preventDefault();
    params.onStop();
  }
}

/** Subscribes a composer to offered reply text from an open page or app card in this chat. */
export function useComposerOffers({
  draftKey,
  pageSession,
  onClearReply,
  onOffer,
}: {
  draftKey: string;
  pageSession: ReturnType<typeof usePageSession>;
  onClearReply?: () => void;
  onOffer: (text: string) => void;
}) {
  const clearReply = useRef(onClearReply);
  clearReply.current = onClearReply;
  const offerRef = useRef(onOffer);
  offerRef.current = onOffer;
  const applyOffer = useRef((text: string) => {
    clearReply.current?.();
    offerRef.current(text);
  });
  useEffect(() => pageSession?.subscribeReply((text) => applyOffer.current(text)), [pageSession]);
  useEffect(
    () => composerDraft.subscribeComposerOffer(draftKey, (text) => applyOffer.current(text)),
    [draftKey],
  );
}

/** Handles pasted files and large text pastes that offer an attach-as-file follow-up. */
export function handleComposerPaste<T extends { text: string }>(
  event: ClipboardEvent<HTMLTextAreaElement>,
  params: {
    disabled?: boolean;
    threshold: number;
    current: T;
    pickAttachments: (files: FileList | readonly File[] | null) => void;
    rememberSelection: (field: HTMLTextAreaElement) => void;
    updateDraft: (value: string, caret: number) => void;
    setPendingCaret: (caret: number) => void;
    setLargePaste: (value: { text: string; before: T; start: number; end: number }) => void;
  },
) {
  const clipboardData = event.clipboardData;
  if (params.disabled || !clipboardData) return;
  const text = clipboardData.getData("text/plain");
  const files = isFilePaste(clipboardData);
  if (!files && text.length <= params.threshold) return;
  event.preventDefault();
  if (files) params.pickAttachments(clipboardData.files);
  if (!text) return;
  const textarea = event.currentTarget;
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  params.rememberSelection(textarea);
  const caret = start + text.length;
  params.updateDraft(
    `${params.current.text.slice(0, start)}${text}${params.current.text.slice(end)}`,
    caret,
  );
  params.setPendingCaret(caret);
  if (!files) params.setLargePaste({ text, before: params.current, start, end });
}
