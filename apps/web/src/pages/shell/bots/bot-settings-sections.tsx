import { Trans, useLingui } from "@lingui/react/macro";
import type {
  ApprovalMode,
  ComputerMode,
  ConversationCompactionMode,
  ThinkingLevel,
  UserDeviceSummary,
} from "@rakazo/contracts";
import {
  BOT_COMPUTER_MODES,
  BOT_DESCRIPTION_MAX_LENGTH,
  BUILTIN_TOOL_NAMES,
  DEFAULT_CUSTOM_CONVERSATION_COMPACTION_TOKENS,
  DEFAULT_MAX_CONCURRENT_HELPERS,
  MAX_CONCURRENT_HELPERS_LIMIT,
  MAX_CUSTOM_CONVERSATION_COMPACTION_TOKENS,
  MAX_TOOL_CALLS_PER_TURN_LIMIT,
  MIN_CUSTOM_CONVERSATION_COMPACTION_TOKENS,
  normalizeBotWorkspacePath,
} from "@rakazo/contracts";
import type { ChatModelChoice } from "@rakazo/core";
import { thinkingLevelLabel } from "@rakazo/i18n/thinking-level";
import {
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldLabel,
  Input,
  OptionSelect,
  SectionHeading,
  Switch,
  Textarea,
  Toggle,
} from "@rakazo/ui-web";
import { X } from "lucide-react";
import type { ReactNode, RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import { ChatModelPicker } from "../chat/chat-model-picker";

export function ComputerModePicker({
  value,
  onChange,
}: {
  value: ComputerMode;
  onChange: (value: ComputerMode) => void;
}) {
  return (
    <div className="grid grid-cols-2 gap-2">
      {BOT_COMPUTER_MODES.map((mode) => (
        <Toggle
          key={mode}
          variant="outline"
          pressed={value === mode}
          onPressedChange={(pressed) => {
            if (pressed) onChange(mode);
          }}
          className="capitalize aria-pressed:border-foreground/40 aria-pressed:text-foreground"
        >
          {mode === "team" ? <Trans>Team</Trans> : <Trans>Private</Trans>}
        </Toggle>
      ))}
    </div>
  );
}

/** A panel section: its label, an optional control beside it, then its content. */
export function PanelSection({
  label,
  action,
  children,
}: {
  label: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <section>
      <SectionHeading variant="label" className="mb-2 flex min-h-6 items-center justify-between">
        {label}
        {action}
      </SectionHeading>
      {children}
    </section>
  );
}

/** Rows of one card. */
export function SettingsCard({ children }: { children: ReactNode }) {
  return <div className="rounded-xl bg-muted/50 px-4 py-1">{children}</div>;
}

export function SwitchRow({
  id,
  label,
  checked,
  disabled,
  onChange,
}: {
  id: string;
  label: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <Field
      orientation="horizontal"
      className="min-h-12 cursor-pointer gap-3 text-body text-foreground"
    >
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Switch id={id} checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </Field>
  );
}

function humanizeTool(name: string) {
  const words = name.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The model row and, when the model offers levels, a thinking row under it. */
export function ModelRow({
  ids,
  containerRef,
  choices,
  value,
  onModelChange,
  thinkingOptions,
  thinkingLevel,
  defaultThinkingLevel,
  onThinkingLevelChange,
}: {
  ids: string;
  containerRef: RefObject<HTMLDivElement | null>;
  choices: readonly ChatModelChoice[];
  value: string;
  onModelChange: (key: string) => void;
  thinkingOptions: ThinkingLevel[];
  thinkingLevel: string;
  defaultThinkingLevel: ThinkingLevel;
  onThinkingLevelChange: (level: string) => void;
}) {
  const { t } = useLingui();
  return (
    <>
      <div ref={containerRef}>
        <ChatModelPicker
          id={`${ids}-model`}
          choices={choices}
          value={value}
          onChange={onModelChange}
        />
      </div>
      {thinkingOptions.length ? (
        <Field orientation="horizontal" className="min-h-12 gap-3 text-body text-foreground">
          <FieldLabel htmlFor={`${ids}-thinking`}>
            <Trans>Thinking</Trans>
          </FieldLabel>
          <OptionSelect
            id={`${ids}-thinking`}
            className="w-fit max-w-2/3"
            value={thinkingLevel}
            onValueChange={onThinkingLevelChange}
            options={[
              { value: "", label: t`Default (${thinkingLevelLabel(defaultThinkingLevel)})` },
              ...thinkingOptions.map((level) => ({
                value: level,
                label: thinkingLevelLabel(level),
              })),
            ]}
          />
        </Field>
      ) : null}
    </>
  );
}

/** The voice that reads replies aloud. */
export function VoiceRow({
  ids,
  voices,
  voiceId,
  onVoiceIdChange,
}: {
  ids: string;
  voices: ReadonlyArray<{ id: string; label: string }>;
  voiceId: string;
  onVoiceIdChange: (voiceId: string) => void;
}) {
  const { t } = useLingui();
  return (
    <Field orientation="horizontal" className="min-h-12 gap-3 text-body text-foreground">
      <FieldLabel htmlFor={`${ids}-voice`}>
        <Trans>Voice</Trans>
      </FieldLabel>
      <OptionSelect
        id={`${ids}-voice`}
        className="w-fit max-w-2/3"
        value={voiceId}
        onValueChange={onVoiceIdChange}
        options={[
          { value: "", label: t`Account default` },
          ...voices.map((voice) => ({ value: voice.id, label: voice.label })),
        ]}
      />
    </Field>
  );
}

export function DescriptionGroup({
  ids,
  description,
  onDescriptionChange,
  onCommit,
}: {
  ids: string;
  description: string;
  onDescriptionChange: (description: string) => void;
  /** Saves the description when the field loses focus. */
  onCommit: () => void;
}) {
  const { t } = useLingui();
  return (
    <PanelSection label={t`Description`}>
      <Textarea
        id={`${ids}-description`}
        aria-label={t`Description`}
        value={description}
        maxLength={BOT_DESCRIPTION_MAX_LENGTH}
        onChange={(e) => onDescriptionChange(e.target.value)}
        onBlur={onCommit}
        placeholder={t`What this bot is for`}
        rows={2}
        className="min-h-16 max-h-96 resize-none field-sizing-content"
      />
      <p className="mt-2 text-body-sm text-muted-foreground">
        <Trans>Other bots read this when deciding whom to ask.</Trans>
      </p>
    </PanelSection>
  );
}

export function ToolsGroup({
  ids,
  disabledBuiltinTools,
  onDisable,
  onEnable,
}: {
  ids: string;
  disabledBuiltinTools: string[];
  onDisable: (name: string) => void;
  onEnable: (name: string) => void;
}) {
  const { t } = useLingui();
  return (
    <PanelSection label={t`Tools`}>
      <section data-testid="bot-settings-tools">
        <div className="space-y-2 [&>*]:mt-0">
          <div>
            <OptionSelect
              id={`${ids}-disabled-tools`}
              aria-label={t`Disable a tool`}
              value=""
              onValueChange={(name) => {
                if (name) onDisable(name);
              }}
              options={[
                { value: "", label: t`Disable a tool` },
                ...BUILTIN_TOOL_NAMES.filter((name) => !disabledBuiltinTools.includes(name)).map(
                  (name) => ({ value: name, label: humanizeTool(name) }),
                ),
              ]}
            />
          </div>
          {disabledBuiltinTools.map((toolName) => (
            <div
              key={toolName}
              className="flex min-h-11 items-center justify-between gap-3 text-body"
            >
              <span>{humanizeTool(toolName)}</span>
              <Button
                id={`${ids}-disabled-${toolName}`}
                variant="ghost"
                size="icon-xs"
                aria-label={t`Enable ${humanizeTool(toolName)}`}
                title={t`Enable ${humanizeTool(toolName)}`}
                onClick={() => onEnable(toolName)}
              >
                <X className="size-4" />
              </Button>
            </div>
          ))}
        </div>
      </section>
    </PanelSection>
  );
}

/**
 * The bot's workspace folder on its computer: commits on Enter or blur, restoring the
 * default when emptied; an invalid path stays in place with its reason shown.
 */
export function WorkspacePathRow({
  id,
  value,
  disabled,
  onCommit,
}: {
  id: string;
  /** The saved folder, "" for the default. */
  value: string;
  disabled?: boolean;
  onCommit: (workspacePath: string | null) => void;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(value);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  // Follow a save confirmed elsewhere while the row is idle; a rejected edit keeps its
  // draft and its reason instead.
  useEffect(() => {
    if (!editing && !error) setDraft(value);
  }, [value, editing, error]);
  function commit() {
    setEditing(false);
    const trimmed = draftRef.current.trim();
    if (!trimmed) {
      setError(null);
      if (value) onCommit(null);
      return;
    }
    const normalized = normalizeBotWorkspacePath(trimmed);
    if (!normalized) {
      setError(t`Use a relative folder path without ".." segments.`);
      return;
    }
    setError(null);
    setDraft(normalized);
    if (normalized !== value) onCommit(normalized);
  }
  return (
    <Field className="gap-1.5 py-3">
      <FieldLabel htmlFor={id} className="text-body text-foreground">
        <Trans>Workspace folder</Trans>
      </FieldLabel>
      <Input
        id={id}
        data-testid="bot-workspace-path"
        value={draft}
        disabled={disabled}
        placeholder={t`projects/website`}
        aria-label={t`Workspace folder`}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        onChange={(event) => setDraft(event.target.value)}
        onFocus={() => setEditing(true)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
      <FieldDescription>
        <Trans>The bot's commands and files start here. Leave empty for the default folder.</Trans>
      </FieldDescription>
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}

/**
 * Which of the owner's paired computers this bot reaches: theirs by name, or whichever is
 * connected. Hidden while the account has none and the bot is bound to none.
 */
export function DeviceRow({
  id,
  value,
  devices,
  boundName,
  disabled,
  onChange,
}: {
  id: string;
  /** The bound device id, null for any connected computer. */
  value: string | null;
  devices: readonly UserDeviceSummary[];
  /** The bound device's saved name, used when it is not in `devices`. */
  boundName?: string;
  disabled?: boolean;
  onChange: (deviceId: string | null) => void;
}) {
  const { t } = useLingui();
  const options = [
    { value: "", label: t`Any connected computer` },
    ...devices.map((device) => ({
      value: device.deviceId,
      label: device.connected ? device.name : t`${device.name} (offline)`,
    })),
  ];
  if (value && !devices.some((device) => device.deviceId === value))
    options.push({
      value,
      label: boundName ? t`${boundName} (offline)` : t`Unavailable computer`,
    });
  return (
    <Field orientation="horizontal" className="min-h-12 gap-3 py-2 text-body">
      <FieldLabel htmlFor={id} className="text-foreground">
        <Trans>Your computer</Trans>
      </FieldLabel>
      <OptionSelect
        id={id}
        data-testid="bot-host-device"
        aria-label={t`Your computer`}
        value={value ?? ""}
        disabled={disabled}
        onValueChange={(next) => {
          if (next !== (value ?? "")) onChange(next || null);
        }}
        options={options}
      />
    </Field>
  );
}

/**
 * How much this bot asks before acting: its own mode, or the owner's Space mode. Auto says
 * why it waits while the Space has no approval model.
 */
export function ApprovalModeRow({
  id,
  value,
  autoAvailable,
  disabled,
  onChange,
}: {
  id: string;
  /** This bot's own mode; null follows the Space. */
  value: ApprovalMode | null;
  /** False while the Space's Auto has no approval model to judge with. */
  autoAvailable: boolean;
  disabled?: boolean;
  onChange: (mode: ApprovalMode | null) => void;
}) {
  const { t } = useLingui();
  return (
    <div className="flex flex-col gap-1.5 py-3">
      <Field orientation="horizontal" className="min-h-12 gap-3 text-body">
        <FieldLabel htmlFor={id} className="text-foreground">
          <Trans>Approval mode</Trans>
        </FieldLabel>
        <OptionSelect
          id={id}
          data-testid="bot-approval-mode"
          aria-label={t`Approval mode`}
          className="w-fit max-w-2/3"
          value={value ?? ""}
          disabled={disabled}
          onValueChange={(next) => onChange(next === "" ? null : (next as ApprovalMode))}
          options={[
            { value: "", label: t`Space default` },
            { value: "ask", label: t`Ask` },
            { value: "auto", label: t`Auto` },
            { value: "never", label: t`Never ask` },
          ]}
        />
      </Field>
      {value === "auto" && !autoAvailable ? (
        <FieldDescription>
          <Trans>Auto needs an approval model; until one is set, this bot asks.</Trans>
        </FieldDescription>
      ) : null}
    </div>
  );
}

/**
 * How many background helpers this bot may run at once; shows the default until one is
 * picked and restores it when the field is emptied.
 */
export function ParallelWorkRow({
  id,
  value,
  disabled,
  onCommit,
}: {
  id: string;
  /** This bot's own limit; null follows the default. */
  value: number | null;
  disabled?: boolean;
  onCommit: (value: number | null) => void;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(() => String(value ?? DEFAULT_MAX_CONCURRENT_HELPERS));
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    if (!editing && !error) setDraft(String(value ?? DEFAULT_MAX_CONCURRENT_HELPERS));
  }, [value, editing, error]);
  function commit() {
    setEditing(false);
    const raw = draftRef.current.trim();
    if (!raw) {
      setError(null);
      if (value !== null) onCommit(null);
      return;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_CONCURRENT_HELPERS_LIMIT) {
      setError(t`Use a whole number from 1 to ${MAX_CONCURRENT_HELPERS_LIMIT}.`);
      return;
    }
    setError(null);
    setDraft(String(parsed));
    const next = parsed === DEFAULT_MAX_CONCURRENT_HELPERS ? null : parsed;
    if (next !== value) onCommit(next);
  }
  return (
    <Field className="gap-1.5 py-3">
      <Field orientation="horizontal" className="min-h-12 gap-3 text-body">
        <FieldLabel htmlFor={id} className="text-foreground">
          <Trans>Tasks at once</Trans>
        </FieldLabel>
        <Input
          id={id}
          data-testid="bot-parallel-work"
          type="number"
          min={1}
          max={MAX_CONCURRENT_HELPERS_LIMIT}
          inputMode="numeric"
          aria-label={t`Tasks at once`}
          value={draft}
          disabled={disabled}
          className="w-20 text-center"
          onChange={(event) => setDraft(event.target.value)}
          onFocus={() => setEditing(true)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
      </Field>
      <FieldDescription>
        <Trans>Background tasks this bot can run at the same time. 3 by default.</Trans>
      </FieldDescription>
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}

/**
 * How soon this bot summarizes older messages. `earlier` and `near_limit` use a share of the
 * model's context window; `custom` keeps an exact observed input-token threshold.
 */
export function ConversationCompactionRow({
  id,
  mode,
  customTokens,
  disabled,
  onChange,
}: {
  id: string;
  mode: ConversationCompactionMode;
  customTokens: number | null;
  disabled?: boolean;
  onChange: (mode: ConversationCompactionMode, customTokens: number | null) => void;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(() => (customTokens == null ? "" : String(customTokens)));
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    if (!editing && !error) setDraft(customTokens == null ? "" : String(customTokens));
  }, [customTokens, editing, error]);

  function commit() {
    setEditing(false);
    const raw = draftRef.current.trim();
    if (!raw) {
      setError(null);
      setDraft(String(DEFAULT_CUSTOM_CONVERSATION_COMPACTION_TOKENS));
      onChange("custom", DEFAULT_CUSTOM_CONVERSATION_COMPACTION_TOKENS);
      return;
    }
    const parsed = Number(raw);
    if (
      !Number.isInteger(parsed) ||
      parsed < MIN_CUSTOM_CONVERSATION_COMPACTION_TOKENS ||
      parsed > MAX_CUSTOM_CONVERSATION_COMPACTION_TOKENS
    ) {
      setError(
        t`Use a whole number from ${MIN_CUSTOM_CONVERSATION_COMPACTION_TOKENS} to ${MAX_CUSTOM_CONVERSATION_COMPACTION_TOKENS}.`,
      );
      return;
    }
    setError(null);
    setDraft(String(parsed));
    if (parsed !== customTokens) onChange("custom", parsed);
  }

  function choosePreset(value: number) {
    setError(null);
    setDraft(String(value));
    onChange("custom", value);
  }

  const help =
    mode === "earlier"
      ? t`Summarizes when the prompt reaches half the model's context window.`
      : mode === "near_limit"
        ? t`Summarizes when the prompt reaches 80% of the model's context window.`
        : mode === "custom"
          ? t`Summarizes when the prompt reaches this many tokens.`
          : t`Keeps the latest 50 messages and summarizes older ones.`;

  return (
    <Field className="gap-1.5 py-3">
      <Field orientation="horizontal" className="min-h-12 gap-3 text-body">
        <FieldLabel htmlFor={id} className="text-foreground">
          <Trans>Compact conversation</Trans>
        </FieldLabel>
        <OptionSelect
          id={id}
          data-testid="bot-conversation-compaction"
          aria-label={t`Compact conversation`}
          className="w-fit max-w-2/3"
          value={mode}
          disabled={disabled}
          onValueChange={(next) => {
            setError(null);
            const choice = next as ConversationCompactionMode;
            if (choice === "custom") {
              const value = customTokens ?? DEFAULT_CUSTOM_CONVERSATION_COMPACTION_TOKENS;
              setDraft(String(value));
              onChange(choice, value);
              return;
            }
            onChange(choice, null);
          }}
          options={[
            { value: "automatic", label: t`Automatic (default)` },
            { value: "earlier", label: t`Earlier` },
            { value: "near_limit", label: t`Near the limit` },
            { value: "custom", label: t`Custom amount` },
          ]}
        />
      </Field>
      {mode === "custom" ? (
        <Field
          orientation="horizontal"
          className="flex-wrap justify-between gap-2 text-body-sm text-muted-foreground"
        >
          <FieldLabel htmlFor={`${id}-tokens`}>
            <Trans>Tokens</Trans>
          </FieldLabel>
          <div className="flex items-center gap-1.5">
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => choosePreset(100_000)}
            >
              <Trans>100K</Trans>
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={disabled}
              onClick={() => choosePreset(200_000)}
            >
              <Trans>200K</Trans>
            </Button>
            <Input
              id={`${id}-tokens`}
              data-testid="bot-conversation-compaction-tokens"
              type="number"
              min={MIN_CUSTOM_CONVERSATION_COMPACTION_TOKENS}
              max={MAX_CUSTOM_CONVERSATION_COMPACTION_TOKENS}
              inputMode="numeric"
              aria-label={t`Tokens`}
              value={draft}
              disabled={disabled}
              className="w-28 text-center"
              onChange={(event) => setDraft(event.target.value)}
              onFocus={() => setEditing(true)}
              onBlur={commit}
              onKeyDown={(event) => {
                if (event.nativeEvent.isComposing || event.keyCode === 229) return;
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.currentTarget.blur();
                }
              }}
            />
          </div>
        </Field>
      ) : null}
      <FieldDescription>{help}</FieldDescription>
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}

/** How many tool calls one turn may make before the agent stops and waits for a new message. */
export function ToolCallLimitRow({
  id,
  value,
  disabled,
  onCommit,
}: {
  id: string;
  value: number | null;
  disabled?: boolean;
  onCommit: (value: number | null) => void;
}) {
  const { t } = useLingui();
  const [draft, setDraft] = useState(() => (value ? String(value) : ""));
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draftRef = useRef(draft);
  draftRef.current = draft;
  useEffect(() => {
    if (!editing && !error) setDraft(value ? String(value) : "");
  }, [value, editing, error]);

  function commit() {
    setEditing(false);
    const raw = draftRef.current.trim();
    if (!raw) {
      setError(null);
      if (value !== null) onCommit(null);
      return;
    }
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_TOOL_CALLS_PER_TURN_LIMIT) {
      setError(t`Use a whole number from 1 to ${MAX_TOOL_CALLS_PER_TURN_LIMIT}.`);
      return;
    }
    setError(null);
    setDraft(String(parsed));
    if (parsed !== value) onCommit(parsed);
  }

  return (
    <Field className="gap-1.5 py-3">
      <Field orientation="horizontal" className="min-h-12 gap-3 text-body">
        <FieldLabel htmlFor={id} className="text-foreground">
          <Trans>Tool calls per turn</Trans>
        </FieldLabel>
        <Input
          id={id}
          data-testid="bot-tool-call-limit"
          type="number"
          min={1}
          max={MAX_TOOL_CALLS_PER_TURN_LIMIT}
          inputMode="numeric"
          aria-label={t`Tool calls per turn`}
          placeholder={t`No limit`}
          value={draft}
          disabled={disabled}
          className="w-24 text-center"
          onChange={(event) => setDraft(event.target.value)}
          onFocus={() => setEditing(true)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing || event.keyCode === 229) return;
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            }
          }}
        />
      </Field>
      <FieldDescription>
        <Trans>The agent stops after this many tool calls in one turn. Empty means no limit.</Trans>
      </FieldDescription>
      {error ? <FieldError>{error}</FieldError> : null}
    </Field>
  );
}
