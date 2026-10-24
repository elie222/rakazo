import { Trans, useLingui } from "@lingui/react/macro";
import type {
  AgentSkillCatalogEntry,
  Bot,
  ComputerMode,
  Me,
  ModelCatalogEntry,
  ModelCredential,
  ThinkingLevel,
  VoiceInfo,
} from "@rakazo/contracts";
import {
  BOT_COMPUTER_MODES,
  BOT_DESCRIPTION_MAX_LENGTH,
  BOT_NAME_MAX_LENGTH,
  BOT_TITLE_MAX_LENGTH,
  BUILTIN_TOOL_NAMES,
  isBuiltinToolName,
} from "@rakazo/contracts";
import {
  chatModelChoices,
  connectedModelChoices,
  credentialForModel,
  modelOptionKey,
  parseModelOptionKey,
  resolveSelectableModelId,
} from "@rakazo/core";
import {
  Button,
  Input,
  NativeSelect,
  NativeSelectOption,
  Switch,
  Textarea,
  Toggle,
} from "@rakazo/ui-web";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@rakazo/ui-web/components/ui/collapsible";
import { ChevronDown, Download, Settings, X } from "lucide-react";
import type { ReactNode } from "react";
import { Suspense, useEffect, useId, useRef, useState } from "react";
import { ErrorBoundary, SectionLoadFailed } from "../../components/ErrorBoundary";
import { InstructionSettings } from "../../components/InstructionSettings";
import { botProfilePatch } from "../../lib/bot-profile-patch";
import { thinkingLevelLabel } from "../../lib/model-catalog";
import { lazyComponent } from "../../lib/preload-recovery";
import { rpc } from "../../lib/rpc";
import { errorText } from "../../lib/user-error";
import { AvatarStudioPopover } from "./avatar-studio-popover";
import { BotCredentialsSection } from "./bot-credentials";
import { ChatModelPicker } from "./chat-model-picker";

const ScratchpadSection = lazyComponent(() =>
  import("../ScratchpadSection").then((module) => module.ScratchpadSection),
);

const KnowledgeSection = lazyComponent(() =>
  import("../KnowledgeSection").then((module) => module.KnowledgeSection),
);

const rowLabelClass = "text-sm text-foreground";

function ComputerModePicker({
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

export function BotSettings({
  bot,
  memoryProviderConfigured,
  onSkillsChange,
  onSave,
  onExport,
  onClear,
  focusModel = 0,
  onOpenConnections,
}: {
  bot: Bot;
  focusModel?: number;
  onOpenConnections?: () => void;
  onSkillsChange: (skills: AgentSkillCatalogEntry[]) => void;
  memoryProviderConfigured: boolean;
  onSave: (patch: {
    name?: string;
    title?: string;
    description?: string;
    instructions?: string;
    color?: string;
    notifyOnFinish?: boolean;
    computerMode?: ComputerMode;
    memoryScope?: "isolated" | "shared" | null;
    autoSpeak?: boolean;
    fleetManagement?: boolean;
    crossSpaceCommunication?: boolean;
    voiceId?: string | null;
    modelProvider?: string | null;
    modelId?: string | null;
    thinkingLevel?: ThinkingLevel | null;
    disabledBuiltinTools?: string[];
  }) => Promise<void>;
  onExport: () => Promise<void>;
  onClear: () => void;
}) {
  const { t } = useLingui();
  const ids = useId();
  const [advancedOpen, setAdvancedOpen] = useState(Boolean(focusModel));
  const modelRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (focusModel) setAdvancedOpen(true);
  }, [focusModel]);
  useEffect(() => {
    if (focusModel && advancedOpen) {
      modelRef.current?.scrollIntoView?.({ block: "nearest" });
      modelRef.current?.querySelector<HTMLElement>('[id$="-model"]')?.focus();
    }
  }, [advancedOpen, focusModel]);
  const [name, setName] = useState(bot.name);
  const [title, setTitle] = useState(bot.title);
  const savedNameRef = useRef(bot.name);
  const savedTitleRef = useRef(bot.title);
  const [description, setDescription] = useState(bot.description);
  // A roster refresh can skip replacing bots while a reorder is in flight, so
  // this prop keeps the description from when the panel opened. Later saves
  // compare against the description last saved here; otherwise a model or
  // voice change treats that stale text as an edit and overwrites instructions.
  const savedDescriptionRef = useRef(bot.description ?? "");
  const [color, setColor] = useState(bot.color);
  const [notifyOnFinish, setNotifyOnFinish] = useState(bot.notifyOnFinish ?? true);
  const acceptedAutomatic = useRef({
    color: bot.color,
    notifyOnFinish: bot.notifyOnFinish ?? true,
  });
  const automaticRevision = useRef({ color: 0, notifyOnFinish: 0 });
  const [computerMode, setComputerMode] = useState(bot.computerMode);
  const [memoryScope, setMemoryScope] = useState(bot.memoryScope);
  const [autoSpeak, setAutoSpeak] = useState(bot.autoSpeak);
  const [crossSpaceCommunication, setCrossSpaceCommunication] = useState(
    bot.crossSpaceCommunication ?? false,
  );
  useEffect(
    () => setCrossSpaceCommunication(bot.crossSpaceCommunication ?? false),
    [bot.crossSpaceCommunication],
  );
  const [fleetManagement, setFleetManagement] = useState(bot.fleetManagement);
  useEffect(() => setFleetManagement(bot.fleetManagement), [bot.fleetManagement]);
  const [voiceId, setVoiceId] = useState(bot.voiceId ?? "");
  const [voices, setVoices] = useState<VoiceInfo[]>([]);
  const [modelKey, setModelKey] = useState(
    bot.modelProvider && bot.modelId ? modelOptionKey(bot.modelProvider, bot.modelId) : "",
  );
  const [thinkingLevel, setThinkingLevel] = useState(bot.thinkingLevel ?? "");
  const [disabledBuiltinTools, setDisabledBuiltinTools] = useState<string[]>(
    bot.disabledBuiltinTools ?? [],
  );
  // The list on screen is updated before the save returns. This stays on the
  // last list the server accepted so a rejection can undo that preview.
  const persistedDisabledToolsRef = useRef(disabledBuiltinTools);
  const serverDisabledToolsRef = useRef(disabledBuiltinTools);
  const pendingSavesRef = useRef(0);
  useEffect(() => {
    const next = bot.disabledBuiltinTools ?? [];
    if (serverDisabledToolsRef.current === next) return;
    serverDisabledToolsRef.current = next;
    persistedDisabledToolsRef.current = next;
    if (pendingSavesRef.current === 0) setDisabledBuiltinTools(next);
  }, [bot.disabledBuiltinTools]);
  const [credentials, setCredentials] = useState<ModelCredential[]>([]);
  const [catalog, setCatalog] = useState<ModelCatalogEntry[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  const [modelMetaReady, setModelMetaReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [savedAdvanced, setSavedAdvanced] = useState(() =>
    JSON.stringify([
      bot.modelProvider && bot.modelId ? modelOptionKey(bot.modelProvider, bot.modelId) : "",
      bot.thinkingLevel ?? "",
      bot.computerMode,
      bot.memoryScope,
      bot.autoSpeak,
      bot.voiceId ?? "",
    ]),
  );
  const advancedSnapshot = JSON.stringify([
    modelKey,
    thinkingLevel,
    computerMode,
    memoryScope,
    autoSpeak,
    voiceId,
  ]);
  const dirty =
    name.trim() !== savedNameRef.current.trim() ||
    title.trim() !== savedTitleRef.current.trim() ||
    advancedSnapshot !== savedAdvanced ||
    description.trim() !== savedDescriptionRef.current;
  const [error, setError] = useState<string | null>(null);
  const saveQueueRef = useRef(Promise.resolve());
  const executeSaveRef = useRef<
    (
      patchOverrides?: {
        name?: string;
        title?: string;
        description?: string;
        color?: string;
        notifyOnFinish?: boolean;
        fleetManagement?: boolean;
        crossSpaceCommunication?: boolean;
        disabledBuiltinTools?: string[];
        baseDisabledBuiltinTools?: string[];
      },
      revisions?: { color: number; notifyOnFinish: number },
    ) => Promise<void>
  >(async () => undefined);
  useEffect(() => {
    void rpc.voice
      .voices({})
      .then(setVoices)
      .catch(() => setVoices([]));
    void Promise.all([rpc.models.credentials(), rpc.models.list(), rpc.me()])
      .then(([nextCredentials, nextCatalog, nextMe]) => {
        setCredentials(nextCredentials);
        setCatalog(nextCatalog);
        setMe(nextMe);
        // Only mark ready on success — a failed catalog load must not clear
        // an existing thinkingLevel override on save.
        setModelMetaReady(true);
      })
      .catch(() => undefined);
  }, []);

  const connectedOptions = connectedModelChoices(credentials, catalog);
  const storedModel = modelKey ? parseModelOptionKey(modelKey) : null;
  const selectedModel = storedModel
    ? {
        provider: storedModel.provider,
        modelId: resolveSelectableModelId(catalog, storedModel.provider, storedModel.modelId),
      }
    : null;
  const selectedModelKey = selectedModel
    ? modelOptionKey(selectedModel.provider, selectedModel.modelId)
    : "";

  const defaultEntry = me?.defaultModel
    ? catalogEntry(catalog, me.defaultProvider, me.defaultModel)
    : undefined;
  const modelChoices = chatModelChoices(
    connectedOptions,
    selectedModelKey,
    t`Space default`,
    defaultEntry?.images,
  );

  const effectiveProvider = selectedModel?.provider ?? me?.defaultProvider ?? null;
  const effectiveModelId = selectedModel?.modelId ?? me?.defaultModel ?? null;
  const effectiveEntry =
    effectiveProvider && effectiveModelId
      ? catalog.find(
          (entry) =>
            entry.provider === effectiveProvider &&
            resolveSelectableModelId(catalog, entry.provider, entry.id) === effectiveModelId,
        )
      : undefined;
  const effectiveCredential = credentialForModel(credentials, effectiveProvider, effectiveModelId);
  const thinkingOptions = (
    effectiveCredential?.thinkingLevels ??
    effectiveEntry?.thinkingLevels ??
    []
  ).filter((level) => level !== "off");
  const defaultThinkingLevel = effectiveCredential?.thinkingLevel ?? "medium";

  async function executeSave(
    patchOverrides?: {
      name?: string;
      title?: string;
      description?: string;
      color?: string;
      notifyOnFinish?: boolean;
      fleetManagement?: boolean;
      crossSpaceCommunication?: boolean;
      disabledBuiltinTools?: string[];
      baseDisabledBuiltinTools?: string[];
    },
    revisions?: { color: number; notifyOnFinish: number },
  ) {
    try {
      setSaving(true);
      setError(null);
      if (patchOverrides?.crossSpaceCommunication !== undefined) {
        await onSave({ crossSpaceCommunication: patchOverrides.crossSpaceCommunication });
        return;
      }
      if (patchOverrides?.fleetManagement !== undefined) {
        await onSave({ fleetManagement: patchOverrides.fleetManagement });
        return;
      }
      const selected = selectedModel;
      const nextName = (patchOverrides?.name !== undefined ? patchOverrides.name : name).trim();
      const nextTitle = (patchOverrides?.title !== undefined ? patchOverrides.title : title).trim();
      const nextDescription = (
        patchOverrides?.description !== undefined ? patchOverrides.description : description
      ).trim();
      const nextColor = patchOverrides?.color !== undefined ? patchOverrides.color : color;
      const nextNotify =
        patchOverrides?.notifyOnFinish !== undefined
          ? patchOverrides.notifyOnFinish
          : notifyOnFinish;

      if (nextName) setName(nextName);
      setTitle(nextTitle);
      setDescription(nextDescription);
      const patch = {
        ...(nextName && nextName !== savedNameRef.current.trim() ? { name: nextName } : {}),
        ...(nextTitle !== savedTitleRef.current.trim() ? { title: nextTitle } : {}),
        // Keep untouched profile fields off the wire.
        ...botProfilePatch(savedDescriptionRef.current, nextDescription),
        // Unchanged color stays off the wire so a legacy named value cannot fail a name save.
        ...(nextColor !== acceptedAutomatic.current.color ? { color: nextColor } : {}),
        notifyOnFinish: nextNotify,
        computerMode,
        memoryScope,
        autoSpeak,
        voiceId: voiceId || null,
        modelProvider: selected?.provider ?? null,
        modelId: selected?.modelId ?? null,
        ...(modelMetaReady &&
        (thinkingOptions.length > 0 ||
          (selected?.provider ?? null) !== bot.modelProvider ||
          (selected?.modelId ?? null) !== bot.modelId)
          ? {
              thinkingLevel: thinkingOptions.length
                ? ((thinkingLevel || null) as ThinkingLevel | null)
                : null,
            }
          : {}),
      };
      const requestedTools = patchOverrides?.disabledBuiltinTools;
      const baseTools = patchOverrides?.baseDisabledBuiltinTools ?? [];
      // Preserve this edit's additions/removals against any refreshed server list.
      // Retry if a refresh arrives while the request is in flight.
      for (;;) {
        const serverTools = serverDisabledToolsRef.current;
        const nextTools =
          requestedTools === undefined
            ? undefined
            : [
                ...persistedDisabledToolsRef.current.filter(
                  (name) => !baseTools.includes(name) || requestedTools.includes(name),
                ),
                ...requestedTools.filter(
                  (name) =>
                    !baseTools.includes(name) && !persistedDisabledToolsRef.current.includes(name),
                ),
              ];
        // Unrelated saves omit the list, preserving changes from other sessions.
        await onSave({
          ...patch,
          ...(nextTools !== undefined ? { disabledBuiltinTools: nextTools } : {}),
        });
        if (nextTools === undefined) break;
        if (
          serverTools !== serverDisabledToolsRef.current &&
          !sameStringList(nextTools, serverDisabledToolsRef.current)
        )
          continue;
        persistedDisabledToolsRef.current = nextTools;
        break;
      }
      acceptedAutomatic.current = { color: nextColor, notifyOnFinish: nextNotify };
      if (nextName) savedNameRef.current = nextName;
      savedTitleRef.current = nextTitle;
      savedDescriptionRef.current = nextDescription;
      setSavedAdvanced(
        JSON.stringify([modelKey, thinkingLevel, computerMode, memoryScope, autoSpeak, voiceId]),
      );
    } catch (err) {
      if (
        patchOverrides?.color !== undefined &&
        revisions?.color === automaticRevision.current.color
      )
        setColor(acceptedAutomatic.current.color);
      if (
        patchOverrides?.notifyOnFinish !== undefined &&
        revisions?.notifyOnFinish === automaticRevision.current.notifyOnFinish
      )
        setNotifyOnFinish(acceptedAutomatic.current.notifyOnFinish);
      if (patchOverrides?.crossSpaceCommunication !== undefined)
        setCrossSpaceCommunication(!patchOverrides.crossSpaceCommunication);
      if (patchOverrides?.fleetManagement !== undefined)
        setFleetManagement(!patchOverrides.fleetManagement);
      setError(errorText(err, t`Could not save`));
    } finally {
      pendingSavesRef.current -= 1;
      if (pendingSavesRef.current === 0) {
        setDisabledBuiltinTools([...persistedDisabledToolsRef.current]);
      }
      setSaving(pendingSavesRef.current > 0);
    }
  }
  executeSaveRef.current = executeSave;

  function disableBuiltinTool(raw: string) {
    const name = raw.trim();
    if (!name) return;
    if (!isBuiltinToolName(name)) return;
    setError(null);
    if (disabledBuiltinTools.includes(name)) return;
    const next = [...disabledBuiltinTools, name];
    setDisabledBuiltinTools(next);
    void enqueueSave({ disabledBuiltinTools: next });
  }

  function enqueueSave(patchOverrides?: {
    name?: string;
    title?: string;
    description?: string;
    color?: string;
    notifyOnFinish?: boolean;
    fleetManagement?: boolean;
    crossSpaceCommunication?: boolean;
    disabledBuiltinTools?: string[];
  }) {
    // Serialize full-object auto-saves so an older in-flight request cannot
    // finish after a newer one and clobber fields. Always call through a ref so
    // queued work reads the latest field values, not a stale render closure.
    pendingSavesRef.current += 1;
    if (patchOverrides?.color !== undefined) automaticRevision.current.color += 1;
    if (patchOverrides?.notifyOnFinish !== undefined) automaticRevision.current.notifyOnFinish += 1;
    const revisions = { ...automaticRevision.current };
    const queuedPatch =
      patchOverrides?.disabledBuiltinTools === undefined
        ? patchOverrides
        : {
            ...patchOverrides,
            baseDisabledBuiltinTools: [...persistedDisabledToolsRef.current],
          };
    saveQueueRef.current = saveQueueRef.current
      .catch(() => undefined)
      .then(() => executeSaveRef.current(queuedPatch, revisions));
    return saveQueueRef.current;
  }

  return (
    <div data-testid="bot-settings">
      <div
        data-testid="bot-profile-header"
        className="flex flex-col items-center pb-6 pt-2 text-center"
      >
        <div className="flex justify-center pb-4">
          <AvatarStudioPopover
            value={color}
            identity={bot.id}
            status={bot.status}
            size={76}
            onChange={(newColor) => {
              setColor(newColor);
              void enqueueSave({ color: newColor });
            }}
          />
        </div>
        <InlineProfileField
          label={t`Name`}
          editLabel={t`Edit name`}
          value={name}
          maxLength={BOT_NAME_MAX_LENGTH}
          className="text-xl font-semibold"
          onCommit={(value) => {
            if (!value.trim()) return;
            setName(value.trim());
            void enqueueSave({ name: value });
          }}
        />
        <InlineProfileField
          label={t`Title`}
          editLabel={t`Edit label`}
          placeholder={t`Add a label`}
          value={title}
          maxLength={BOT_TITLE_MAX_LENGTH}
          className="mt-1 text-sm text-muted-foreground"
          onCommit={(value) => {
            setTitle(value.trim());
            void enqueueSave({ title: value });
          }}
        />
      </div>
      <InstructionSettings key={bot.id} bot={bot} />
      <section className="mt-6">
        <h3 className="mb-2 text-xs font-medium text-muted-foreground">
          <Trans>Notifications</Trans>
        </h3>
        <div className="flex items-center justify-between gap-3 rounded-xl bg-muted/50 p-4">
          <div>
            <label
              htmlFor={`${ids}-notify-finish`}
              id={`${ids}-notify-finish-label`}
              className="text-sm"
            >
              <Trans>When it finishes or needs input</Trans>
            </label>
          </div>
          <Switch
            id={`${ids}-notify-finish`}
            checked={notifyOnFinish}
            aria-labelledby={`${ids}-notify-finish-label`}
            onCheckedChange={(checked) => {
              setNotifyOnFinish(checked);
              void enqueueSave({ notifyOnFinish: checked });
            }}
          />
        </div>
      </section>
      <ErrorBoundary fallback={<SectionLoadFailed />}>
        <Suspense fallback={null}>
          <ScratchpadSection botId={bot.id} />
        </Suspense>
      </ErrorBoundary>
      <ErrorBoundary fallback={<SectionLoadFailed />}>
        <Suspense fallback={null}>
          <KnowledgeSection botId={bot.id} onSkillsChange={onSkillsChange} />
        </Suspense>
      </ErrorBoundary>
      <Collapsible
        open={advancedOpen}
        onOpenChange={setAdvancedOpen}
        data-testid="bot-settings-advanced"
        className="mt-6"
      >
        <h3 className="mb-0 text-xs font-medium text-muted-foreground">
          <CollapsibleTrigger className="group flex w-full cursor-pointer min-h-11 items-center justify-between gap-2 text-xs font-medium text-muted-foreground text-start outline-none focus-visible:ring-3 focus-visible:ring-ring/50">
            <Trans>Advanced</Trans>
            <ChevronDown
              aria-hidden="true"
              className="size-4 text-muted-foreground transition-transform -rotate-90 group-aria-expanded:rotate-0 motion-reduce:transition-none"
            />
          </CollapsibleTrigger>
        </h3>
        <CollapsibleContent>
          <div className="space-y-6 pt-6">
            <div ref={modelRef}>
              <div className="mb-2 flex items-center justify-between text-xs font-medium text-muted-foreground pe-1">
                <Trans>Model</Trans>
                {onOpenConnections ? (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    aria-label={t`Model connections`}
                    onClick={onOpenConnections}
                  >
                    <Settings className="size-4" />
                  </Button>
                ) : null}
              </div>
              <div className="rounded-xl bg-muted/50 p-4 space-y-3">
                <div className="flex min-h-11 items-center justify-between gap-3">
                  <label htmlFor={`${ids}-model`} className="sr-only">
                    <Trans>Model</Trans>
                  </label>
                  <div className="min-w-0 w-full [&>div]:mt-0 [&>button]:mt-0">
                    <ChatModelPicker
                      id={`${ids}-model`}
                      choices={modelChoices}
                      value={selectedModelKey}
                      onChange={(key) => {
                        setModelKey(key);
                        setThinkingLevel("");
                      }}
                    />
                  </div>
                </div>
                {thinkingOptions.length ? (
                  <label
                    htmlFor={`${ids}-thinking`}
                    className="flex min-h-11 items-center justify-between gap-3 text-sm text-foreground"
                  >
                    <Trans>Thinking</Trans>
                    <NativeSelect
                      id={`${ids}-thinking`}
                      className="max-w-2/3"
                      value={thinkingLevel}
                      onChange={(event) => setThinkingLevel(event.target.value)}
                    >
                      <NativeSelectOption value="">
                        {t`Default (${thinkingLevelLabel(defaultThinkingLevel)})`}
                      </NativeSelectOption>
                      {thinkingOptions.map((level) => (
                        <NativeSelectOption key={level} value={level}>
                          {thinkingLevelLabel(level)}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </label>
                ) : null}
              </div>
            </div>
            <SettingsGroup label={t`Computer`}>
              <ComputerModePicker value={computerMode} onChange={setComputerMode} />
              {memoryProviderConfigured ? (
                <div className="mt-4 text-sm text-foreground">
                  <Trans>Memory scope</Trans>
                  <div className="mt-2 flex gap-2">
                    {(
                      [
                        { value: null, label: t`Inherit default` },
                        { value: "isolated" as const, label: t`Isolated` },
                        { value: "shared" as const, label: t`Shared` },
                      ] satisfies Array<{ value: "isolated" | "shared" | null; label: string }>
                    ).map((option) => (
                      <Toggle
                        key={option.label}
                        variant="outline"
                        size="sm"
                        pressed={memoryScope === option.value}
                        onPressedChange={(pressed) => {
                          if (pressed) setMemoryScope(option.value);
                        }}
                        className="flex-1 aria-pressed:border-foreground/40 aria-pressed:text-foreground"
                      >
                        {option.label}
                      </Toggle>
                    ))}
                  </div>
                </div>
              ) : null}
            </SettingsGroup>
            <SettingsGroup label={t`Voice`}>
              <label
                htmlFor={`${ids}-auto-speak`}
                className="flex min-h-11 cursor-pointer items-center justify-between gap-3 text-sm text-foreground"
              >
                <span className={rowLabelClass}>
                  <Trans>Read replies aloud</Trans>
                </span>
                <Switch
                  id={`${ids}-auto-speak`}
                  checked={autoSpeak}
                  onCheckedChange={(checked) => setAutoSpeak(checked)}
                />
              </label>
              {voices.length ? (
                <label
                  htmlFor={`${ids}-voice`}
                  className="flex min-h-11 items-center justify-between gap-3 text-sm text-foreground"
                >
                  <Trans>Voice</Trans>
                  <NativeSelect
                    id={`${ids}-voice`}
                    className="max-w-2/3"
                    value={voiceId}
                    onChange={(event) => setVoiceId(event.target.value)}
                  >
                    <NativeSelectOption value="">{t`Account default`}</NativeSelectOption>
                    {voices.map((voice) => (
                      <NativeSelectOption key={voice.id} value={voice.id}>
                        {voice.label}
                      </NativeSelectOption>
                    ))}
                  </NativeSelect>
                </label>
              ) : null}
            </SettingsGroup>
            <SettingsGroup label={t`Permissions`}>
              <div className="flex min-h-11 items-center justify-between gap-3 text-sm">
                <label htmlFor={`${ids}-cross-space`} className={rowLabelClass}>
                  <Trans>Allow cross-space bot communication</Trans>
                </label>
                <Switch
                  id={`${ids}-cross-space`}
                  checked={crossSpaceCommunication}
                  disabled={saving}
                  onCheckedChange={(checked) => {
                    setCrossSpaceCommunication(checked);
                    void enqueueSave({ crossSpaceCommunication: checked });
                  }}
                />
              </div>
              <div className="flex min-h-11 items-center justify-between gap-3 text-sm">
                <div>
                  <label htmlFor={`${ids}-fleet-management`} className={rowLabelClass}>
                    <Trans>Manage the bots it creates</Trans>
                  </label>
                  <p className="mt-1 text-xs text-muted-foreground">
                    <Trans>Can edit and organise bots it creates</Trans>
                  </p>
                </div>
                <Switch
                  id={`${ids}-fleet-management`}
                  checked={fleetManagement}
                  disabled={saving}
                  onCheckedChange={(checked) => {
                    setFleetManagement(checked);
                    void enqueueSave({ fleetManagement: checked });
                  }}
                />
              </div>
            </SettingsGroup>
            <SettingsGroup label={t`Description`}>
              <label htmlFor={`${ids}-description`} className="block text-xs text-muted-foreground">
                <Trans>How other bots see it</Trans>
                <Textarea
                  id={`${ids}-description`}
                  aria-label={t`Description`}
                  value={description}
                  maxLength={BOT_DESCRIPTION_MAX_LENGTH}
                  onChange={(e) => setDescription(e.target.value)}
                  onBlur={() => void enqueueSave()}
                  placeholder={t`What this bot is for`}
                  rows={2}
                  className="mt-2 min-h-16 resize-none field-sizing-content border-0 bg-transparent p-0 text-foreground shadow-none"
                />
              </label>
            </SettingsGroup>
            <SettingsGroup label={t`Tools`}>
              <section data-testid="bot-settings-tools">
                <div className="space-y-4 [&>*]:mt-0">
                  <div>
                    <NativeSelect
                      id={`${ids}-disabled-tools`}
                      aria-label={t`Disable a tool`}
                      value=""
                      onChange={(event) => disableBuiltinTool(event.target.value)}
                      className="w-full"
                    >
                      <NativeSelectOption value="">{t`Disable a tool`}</NativeSelectOption>
                      {BUILTIN_TOOL_NAMES.filter(
                        (name) => !disabledBuiltinTools.includes(name),
                      ).map((name) => (
                        <NativeSelectOption key={name} value={name}>
                          {humanizeTool(name)}
                        </NativeSelectOption>
                      ))}
                    </NativeSelect>
                  </div>
                  {disabledBuiltinTools.map((toolName) => (
                    <div
                      key={toolName}
                      className="flex min-h-11 items-center justify-between gap-3 text-sm"
                    >
                      <span>{humanizeTool(toolName)}</span>
                      <Button
                        id={`${ids}-disabled-${toolName}`}
                        variant="ghost"
                        size="icon-xs"
                        aria-label={t`Enable ${humanizeTool(toolName)}`}
                        title={t`Enable ${humanizeTool(toolName)}`}
                        onClick={() => {
                          const next = disabledBuiltinTools.filter((entry) => entry !== toolName);
                          setDisabledBuiltinTools(next);
                          void enqueueSave({ disabledBuiltinTools: next });
                        }}
                      >
                        <X className="size-4" />
                      </Button>
                    </div>
                  ))}
                </div>
              </section>
            </SettingsGroup>
            <BotCredentialsSection botId={bot.id} />
            <ErrorBoundary fallback={<SectionLoadFailed />}>
              <Suspense fallback={null}>
                <KnowledgeSection botId={bot.id} onSkillsChange={onSkillsChange} skillsOnly />
              </Suspense>
            </ErrorBoundary>
            <div className="overflow-hidden rounded-xl bg-muted/50 px-4">
              <button
                type="button"
                className="flex min-h-12 w-full items-center justify-between text-sm"
                onClick={() => void onExport()}
              >
                <Trans>Export</Trans>
                <Download className="size-4 text-muted-foreground" />
              </button>
              <button
                type="button"
                className="min-h-12 w-full border-t border-border text-start text-sm text-destructive"
                onClick={onClear}
              >
                <Trans>Clear conversation</Trans>
              </button>
            </div>
          </div>
        </CollapsibleContent>
      </Collapsible>
      {error ? <p className="mt-2 text-[13px] text-destructive">{error}</p> : null}
      {dirty ? (
        <Button
          className="sticky bottom-0 mt-5 w-full"
          disabled={saving}
          onClick={() => {
            void enqueueSave({
              name,
              title,
              description,
              color,
              notifyOnFinish,
            });
          }}
        >
          <Trans>Save</Trans>
        </Button>
      ) : null}
    </div>
  );
}

function sameStringList(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function catalogEntry(
  catalog: ModelCatalogEntry[],
  provider: string | null | undefined,
  modelId: string,
) {
  if (!provider) return undefined;
  return catalog.find((entry) => entry.provider === provider && entry.id === modelId);
}

function InlineProfileField({
  label,
  editLabel,
  value,
  placeholder,
  maxLength,
  className,
  onCommit,
}: {
  label: string;
  editLabel: string;
  value: string;
  placeholder?: string;
  maxLength: number;
  className: string;
  onCommit: (value: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const cancelled = useRef(false);
  function commit() {
    if (cancelled.current) return;
    setEditing(false);
    if (draft.trim() !== value.trim()) onCommit(draft);
  }
  return editing ? (
    <Input
      autoFocus
      aria-label={label}
      value={draft}
      maxLength={maxLength}
      className={`h-auto border-transparent bg-transparent p-0 text-center shadow-none ${className}`}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          commit();
        }
        if (event.key === "Escape") {
          cancelled.current = true;
          setEditing(false);
        }
      }}
    />
  ) : (
    <button
      type="button"
      aria-label={editLabel}
      className={`min-w-0 max-w-full cursor-text break-words rounded px-2 outline-none focus-visible:ring-2 focus-visible:ring-ring ${className}`}
      onClick={() => {
        cancelled.current = false;
        setDraft(value);
        setEditing(true);
      }}
    >
      {value || placeholder}
    </button>
  );
}

function SettingsGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-xs font-medium text-muted-foreground">{label}</h3>
      <div className="space-y-3 rounded-xl bg-muted/50 p-4 [&>*]:mt-0">{children}</div>
    </section>
  );
}
function humanizeTool(name: string) {
  const words = name.replaceAll("_", " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
