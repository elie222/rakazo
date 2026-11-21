import { Trans, useLingui } from "@lingui/react/macro";
import type {
  Bot,
  BotAvatarSet,
  ComputerMode,
  ModelCatalogEntry,
  ThinkingLevel,
} from "@rakazo/contracts";
import { BOT_NAME_MAX_LENGTH, isBuiltinToolName, resolveBotAvatarSet } from "@rakazo/contracts";
import { botModelState, modelOptionKey } from "@rakazo/core";
import { localizeModelEntry } from "@rakazo/i18n/model-provider";
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  SectionHeading,
} from "@rakazo/ui-web";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronLeft, ChevronRight, MoreHorizontal, Plus, X } from "lucide-react";
import type { ComponentProps, ReactNode } from "react";
import { Suspense, useEffect, useId, useRef, useState } from "react";
import { BotEmailAddressField } from "../../../components/BotEmailAddressField";
import { ComputerHomeVersions } from "../../../components/computers/ComputerHomeVersions";
import { ErrorBoundary, SectionLoadFailed } from "../../../components/ErrorBoundary";
import { PagesList } from "../../../components/pages/PagesList";
import { botProfilePatch } from "../../../lib/bots/bot-profile-patch";
import { lazyComponent } from "../../../lib/platform/preload-recovery";
import { useSpaceQueries } from "../../../lib/query/query";
import { errorText } from "../../../lib/query/user-error";
import { ROUTINE_PREVIEW_COUNT, RoutineList } from "../../routines/RoutineList";
import { AvatarStudioPopover } from "./avatar-studio-popover";
import {
  DescriptionGroup,
  PanelSection,
  SettingsCard,
  SwitchRow,
  ToolsGroup,
  VoiceRow,
} from "./bot-settings-sections";
import { ExecutionModelSection } from "./execution-model-section";
import { InstructionSettings } from "./instruction-settings";

const ScratchpadSection = lazyComponent(() =>
  import("../../space/ScratchpadSection").then((module) => module.ScratchpadSection),
);

const KnowledgeSection = lazyComponent(() =>
  import("../../space/KnowledgeSection").then((module) => module.KnowledgeSection),
);

/** The fields saved together as soon as one changes, in the order their saved snapshot keeps them. */
function advancedValues(bot: Bot) {
  return [
    bot.modelProvider && bot.modelId ? modelOptionKey(bot.modelProvider, bot.modelId) : "",
    bot.thinkingLevel ?? "",
    bot.computerMode,
    bot.autoSpeak,
    bot.voiceId ?? "",
  ] as const;
}

/** The panel itself, or one of its whole lists. */
export type BotPanelView = "settings" | "routines" | "pages";

/**
 * A bot's panel: its profile, then its computer, routines and pages, then its settings, with the
 * rarely changed ones folded away.
 */
export function BotSettings({
  bot,
  view = "settings",
  onViewChange,
  onClose,
  computer,
  routines,
  onSave,
  onExport,
  onClear,
  focusModel = 0,
}: {
  bot: Bot;
  view?: BotPanelView;
  onViewChange?: (view: BotPanelView) => void;
  onClose?: () => void;
  computer?: ReactNode;
  routines?: Omit<ComponentProps<typeof RoutineList>, "preview">;
  focusModel?: number;
  onSave: (patch: {
    name?: string;
    description?: string;
    instructions?: string;
    color?: string;
    avatarSet?: BotAvatarSet;
    notifyOnFinish?: boolean;
    computerMode?: ComputerMode;
    autoSpeak?: boolean;
    fleetManagement?: boolean;
    crossSpaceCommunication?: boolean;
    dailyCheckIns?: boolean;
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
  const modelRef = useRef<HTMLDivElement>(null);
  // A model deep link opens Settings, then focuses the model once Settings is shown: a control
  // inside a hidden section cannot take focus.
  const modelFocusPending = useRef(false);
  useEffect(() => {
    if (focusModel && view === "settings") {
      modelFocusPending.current = true;
      setSettingsOpen(true);
    }
  }, [view, focusModel]);
  const [name, setName] = useState(bot.name);
  const savedNameRef = useRef(bot.name);
  const [description, setDescription] = useState(bot.description);
  // A roster refresh can skip replacing bots while a reorder is in flight, so
  // this prop keeps the description from when the panel opened. Later saves
  // compare against the description last saved here; otherwise a model or
  // voice change treats that stale text as an edit and overwrites instructions.
  const savedDescriptionRef = useRef(bot.description ?? "");
  const [color, setColor] = useState(bot.color);
  const [avatarSet, setAvatarSet] = useState(() => resolveBotAvatarSet(bot.avatarSet));
  const [notifyOnFinish, setNotifyOnFinish] = useState(bot.notifyOnFinish ?? true);
  const acceptedAutomatic = useRef({
    color: bot.color,
    avatarSet: resolveBotAvatarSet(bot.avatarSet),
    notifyOnFinish: bot.notifyOnFinish ?? true,
  });
  const automaticRevision = useRef({ color: 0, avatarSet: 0, notifyOnFinish: 0 });
  const [computerMode, setComputerMode] = useState(bot.computerMode);
  const [autoSpeak, setAutoSpeak] = useState(bot.autoSpeak);
  const [crossSpaceCommunication, setCrossSpaceCommunication] = useState(
    bot.crossSpaceCommunication ?? true,
  );
  useEffect(
    () => setCrossSpaceCommunication(bot.crossSpaceCommunication ?? true),
    [bot.crossSpaceCommunication],
  );
  const [dailyCheckIns, setDailyCheckIns] = useState(bot.dailyCheckIns ?? true);
  useEffect(() => setDailyCheckIns(bot.dailyCheckIns ?? true), [bot.dailyCheckIns]);
  const [fleetManagement, setFleetManagement] = useState(bot.fleetManagement);
  useEffect(() => setFleetManagement(bot.fleetManagement), [bot.fleetManagement]);
  // A setting this panel no longer offers still shows while the bot has it changed from the
  // default, so it can be put back. Decided once, so the row stays to undo a change.
  const changedNow = {
    readAloud: bot.autoSpeak || Boolean(bot.voiceId),
    dailyCheckIns: bot.dailyCheckIns === false,
    crossSpaceCommunication: bot.crossSpaceCommunication === false,
    fleetManagement: !bot.fleetManagement,
    tools: (bot.disabledBuiltinTools ?? []).length > 0,
  };
  // Once shown, a row stays, so newer bot data can reveal one but never hide one mid-edit.
  const [changedBefore, setChangedBefore] = useState(changedNow);
  const changed = {
    readAloud: changedBefore.readAloud || changedNow.readAloud,
    dailyCheckIns: changedBefore.dailyCheckIns || changedNow.dailyCheckIns,
    crossSpaceCommunication:
      changedBefore.crossSpaceCommunication || changedNow.crossSpaceCommunication,
    fleetManagement: changedBefore.fleetManagement || changedNow.fleetManagement,
    tools: changedBefore.tools || changedNow.tools,
  };
  if (
    Object.entries(changed).some(([key, on]) => on !== changedBefore[key as keyof typeof changed])
  )
    setChangedBefore(changed);
  const [settingsOpen, setSettingsOpen] = useState(false);
  useEffect(() => {
    if (!settingsOpen || !modelFocusPending.current) return;
    modelFocusPending.current = false;
    modelRef.current?.scrollIntoView?.({ block: "nearest" });
    modelRef.current?.querySelector<HTMLElement>('[id$="-model"]')?.focus();
  }, [settingsOpen, view, focusModel]);
  const [claimingEmail, setClaimingEmail] = useState(false);
  const [voiceId, setVoiceId] = useState(bot.voiceId ?? "");
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
  // Shared with the model and voice settings, so a revisit paints at once and refreshes behind.
  const queries = useSpaceQueries();
  const refresh = { refetchOnMount: "always" } as const;
  const voices = useQuery({ ...queries.voice.voices.queryOptions({ input: {} }), ...refresh }).data;
  const credentialsQuery = useQuery({ ...queries.models.credentials.queryOptions(), ...refresh });
  const catalogQuery = useQuery({ ...queries.models.list.queryOptions(), ...refresh });
  const meQuery = useQuery({ ...queries.me.queryOptions(), ...refresh });
  const credentials = credentialsQuery.data ?? NO_CREDENTIALS;
  const catalog = catalogQuery.data ?? NO_CATALOG;
  const me = meQuery.data ?? null;
  // A failed catalog load must not clear an existing thinkingLevel override on save.
  const modelMetaReady =
    credentialsQuery.data !== undefined &&
    catalogQuery.data !== undefined &&
    meQuery.data !== undefined;
  const [saving, setSaving] = useState(false);
  const [savedAdvanced, setSavedAdvanced] = useState(() => JSON.stringify(advancedValues(bot)));
  const advancedSnapshot = JSON.stringify([
    modelKey,
    thinkingLevel,
    computerMode,
    autoSpeak,
    voiceId,
  ]);
  const [error, setError] = useState<string | null>(null);
  const saveQueueRef = useRef(Promise.resolve());
  const executeSaveRef = useRef<
    (
      patchOverrides?: {
        name?: string;
        description?: string;
        color?: string;
        avatarSet?: BotAvatarSet;
        notifyOnFinish?: boolean;
        fleetManagement?: boolean;
        crossSpaceCommunication?: boolean;
        dailyCheckIns?: boolean;
        disabledBuiltinTools?: string[];
        baseDisabledBuiltinTools?: string[];
      },
      revisions?: { color: number; avatarSet: number; notifyOnFinish: number },
    ) => Promise<void>
  >(async () => undefined);
  // The panel can open on a cached bot. When a newer copy arrives, every field not edited since
  // follows it, so a later save does not send the cached values back over it. A copy that is not
  // newer (a roster read from before a save) is ignored.
  const shownBotRef = useRef(bot);
  useEffect(() => {
    if (bot.updatedAt <= shownBotRef.current.updatedAt) return;
    shownBotRef.current = bot;
    if (name.trim() === savedNameRef.current.trim()) setName(bot.name);
    savedNameRef.current = bot.name;
    if (description.trim() === savedDescriptionRef.current) setDescription(bot.description);
    savedDescriptionRef.current = bot.description ?? "";
    const accepted = acceptedAutomatic.current;
    const nextNotify = bot.notifyOnFinish ?? true;
    if (color === accepted.color) setColor(bot.color);
    const nextAvatarSet = resolveBotAvatarSet(bot.avatarSet);
    if (avatarSet === accepted.avatarSet) setAvatarSet(nextAvatarSet);
    if (notifyOnFinish === accepted.notifyOnFinish) setNotifyOnFinish(nextNotify);
    acceptedAutomatic.current = {
      color: bot.color,
      avatarSet: nextAvatarSet,
      notifyOnFinish: nextNotify,
    };
    const saved = JSON.parse(savedAdvanced) as unknown[];
    const next = advancedValues(bot);
    if (modelKey === saved[0]) setModelKey(next[0]);
    if (thinkingLevel === saved[1]) setThinkingLevel(next[1]);
    if (computerMode === saved[2]) setComputerMode(next[2]);
    if (autoSpeak === saved[3]) setAutoSpeak(next[3]);
    if (voiceId === saved[4]) setVoiceId(next[4]);
    setSavedAdvanced(JSON.stringify(next));
  }, [bot]);

  const {
    selectedModel,
    selectedModelKey,
    choices: modelChoices,
    thinkingLevels: thinkingOptions,
    defaultThinkingLevel,
  } = botModelState({
    credentials,
    catalog: catalog.map(localizeModelEntry),
    me,
    modelKey,
    spaceDefaultLabel: t`Space default`,
  });

  async function executeSave(
    patchOverrides?: {
      name?: string;
      description?: string;
      color?: string;
      avatarSet?: BotAvatarSet;
      notifyOnFinish?: boolean;
      fleetManagement?: boolean;
      crossSpaceCommunication?: boolean;
      dailyCheckIns?: boolean;
      disabledBuiltinTools?: string[];
      baseDisabledBuiltinTools?: string[];
    },
    revisions?: { color: number; avatarSet: number; notifyOnFinish: number },
  ) {
    try {
      setSaving(true);
      setError(null);
      if (patchOverrides?.crossSpaceCommunication !== undefined) {
        await onSave({ crossSpaceCommunication: patchOverrides.crossSpaceCommunication });
        return;
      }
      if (patchOverrides?.dailyCheckIns !== undefined) {
        await onSave({ dailyCheckIns: patchOverrides.dailyCheckIns });
        return;
      }
      if (patchOverrides?.fleetManagement !== undefined) {
        await onSave({ fleetManagement: patchOverrides.fleetManagement });
        return;
      }
      const selected = selectedModel;
      const nextName = (patchOverrides?.name !== undefined ? patchOverrides.name : name).trim();
      const nextDescription = (
        patchOverrides?.description !== undefined ? patchOverrides.description : description
      ).trim();
      const nextColor = patchOverrides?.color !== undefined ? patchOverrides.color : color;
      const nextAvatarSet = patchOverrides?.avatarSet ?? avatarSet;
      const nextNotify =
        patchOverrides?.notifyOnFinish !== undefined
          ? patchOverrides.notifyOnFinish
          : notifyOnFinish;

      if (nextName) setName(nextName);
      setDescription(nextDescription);
      const patch = {
        ...(nextName && nextName !== savedNameRef.current.trim() ? { name: nextName } : {}),
        // Keep untouched profile fields off the wire.
        ...botProfilePatch(savedDescriptionRef.current, nextDescription),
        // Unchanged color stays off the wire so a legacy named value cannot fail a name save.
        ...(nextColor !== acceptedAutomatic.current.color ? { color: nextColor } : {}),
        ...(patchOverrides?.avatarSet !== undefined ||
        nextAvatarSet !== acceptedAutomatic.current.avatarSet
          ? { avatarSet: nextAvatarSet }
          : {}),
        notifyOnFinish: nextNotify,
        computerMode,
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
      acceptedAutomatic.current = {
        color: nextColor,
        avatarSet: nextAvatarSet,
        notifyOnFinish: nextNotify,
      };
      if (nextName) savedNameRef.current = nextName;
      savedDescriptionRef.current = nextDescription;
      setSavedAdvanced(JSON.stringify([modelKey, thinkingLevel, computerMode, autoSpeak, voiceId]));
    } catch (err) {
      if (
        patchOverrides?.color !== undefined &&
        revisions?.color === automaticRevision.current.color
      )
        setColor(acceptedAutomatic.current.color);
      if (
        patchOverrides?.avatarSet !== undefined &&
        revisions?.avatarSet === automaticRevision.current.avatarSet
      )
        setAvatarSet(acceptedAutomatic.current.avatarSet);
      if (
        patchOverrides?.notifyOnFinish !== undefined &&
        revisions?.notifyOnFinish === automaticRevision.current.notifyOnFinish
      )
        setNotifyOnFinish(acceptedAutomatic.current.notifyOnFinish);
      if (patchOverrides?.crossSpaceCommunication !== undefined)
        setCrossSpaceCommunication(!patchOverrides.crossSpaceCommunication);
      if (patchOverrides?.dailyCheckIns !== undefined)
        setDailyCheckIns(!patchOverrides.dailyCheckIns);
      if (patchOverrides?.fleetManagement !== undefined)
        setFleetManagement(!patchOverrides.fleetManagement);
      // A refused model, computer or voice change goes back to what the server still holds.
      if (!patchOverrides) {
        const saved = JSON.parse(savedAdvanced) as ReturnType<typeof advancedValues>;
        setModelKey(saved[0]);
        setThinkingLevel(saved[1]);
        setComputerMode(saved[2]);
        setAutoSpeak(saved[3]);
        setVoiceId(saved[4]);
      }
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
    description?: string;
    color?: string;
    avatarSet?: BotAvatarSet;
    notifyOnFinish?: boolean;
    fleetManagement?: boolean;
    crossSpaceCommunication?: boolean;
    dailyCheckIns?: boolean;
    disabledBuiltinTools?: string[];
  }) {
    // Serialize full-object auto-saves so an older in-flight request cannot
    // finish after a newer one and clobber fields. Always call through a ref so
    // queued work reads the latest field values, not a stale render closure.
    pendingSavesRef.current += 1;
    if (patchOverrides?.color !== undefined) automaticRevision.current.color += 1;
    if (patchOverrides?.avatarSet !== undefined) automaticRevision.current.avatarSet += 1;
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

  // The model, thinking level, computer and voice save as soon as one of them changes.
  useEffect(() => {
    if (advancedSnapshot !== savedAdvanced) void enqueueSave();
  }, [advancedSnapshot]);

  const email = useQuery(queries.bots.emailAddress.queryOptions({ input: { botId: bot.id } })).data;
  const routineCount = routines?.routines.length ?? 0;
  const headerButtons = (
    <Button
      variant="ghost"
      size="icon"
      className="text-muted-foreground"
      aria-label={t`Close panel`}
      onClick={onClose}
    >
      <X className="size-4.5" strokeWidth={1.75} />
    </Button>
  );

  return (
    <div data-testid="bot-settings">
      {view !== "settings" ? (
        <div className="mb-4 flex items-center justify-between">
          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground"
            aria-label={t`Back`}
            onClick={() => onViewChange?.("settings")}
          >
            <ChevronLeft className="size-4.5 rtl:rotate-180" strokeWidth={1.75} />
          </Button>
          <div className="text-body-lg font-medium text-foreground">
            {view === "routines" ? <Trans>Routines</Trans> : <Trans>Pages</Trans>}
          </div>
          {headerButtons}
        </div>
      ) : null}
      {view === "routines" && routines ? <RoutineList {...routines} /> : null}
      {view === "pages" ? <PagesList botId={bot.id} /> : null}
      {/* Stays mounted so drafts and the open sections survive a visit to a whole list. */}
      <div hidden={view !== "settings"}>
        <div className="mb-4 flex items-center justify-end gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground"
                  aria-label={t`More actions`}
                />
              }
            >
              <MoreHorizontal className="size-4.5" strokeWidth={1.75} />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              {email && !email.address && !claimingEmail ? (
                <DropdownMenuItem onClick={() => setClaimingEmail(true)}>
                  <Trans>Get an email address</Trans>
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem
                onClick={() => {
                  setError(null);
                  onExport().catch((err: unknown) => setError(errorText(err)));
                }}
              >
                <Trans>Export</Trans>
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={onClear}>
                <Trans>Clear conversation</Trans>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {headerButtons}
        </div>
        <div
          data-testid="bot-profile-header"
          className="flex flex-col items-center pb-5 text-center"
        >
          <div className="flex justify-center pb-4">
            <AvatarStudioPopover
              value={color}
              identity={bot.id}
              status={bot.status}
              size={76}
              avatarSet={avatarSet}
              onChange={(newColor, nextAvatarSet) => {
                setColor(newColor);
                if (nextAvatarSet !== undefined) setAvatarSet(nextAvatarSet);
                void enqueueSave({
                  color: newColor,
                  ...(nextAvatarSet !== undefined ? { avatarSet: nextAvatarSet } : {}),
                });
              }}
            />
          </div>
          <InlineProfileField
            label={t`Name`}
            editLabel={t`Edit name`}
            value={name}
            maxLength={BOT_NAME_MAX_LENGTH}
            className="text-heading2 font-semibold"
            onCommit={(value) => {
              if (!value.trim()) return;
              setName(value.trim());
              void enqueueSave({ name: value });
            }}
          />
          {email && (email.address || claimingEmail) ? (
            <div data-testid="bot-email" className="mt-2 w-full max-w-sm text-left">
              <BotEmailAddressField
                bot={{ id: bot.id, name }}
                domain={email.domain}
                address={email.address}
              />
            </div>
          ) : null}
        </div>
        <div className="space-y-6">
          {computer ? (
            <PanelSection label={<Trans>Computer</Trans>}>{computer}</PanelSection>
          ) : null}
          {routines ? (
            <PanelSection
              label={
                routineCount > ROUTINE_PREVIEW_COUNT ? (
                  <button
                    type="button"
                    onClick={() => onViewChange?.("routines")}
                    className="flex items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Trans>Routines</Trans>
                    <ChevronRight aria-hidden="true" className="size-3.5 rtl:rotate-180" />
                  </button>
                ) : (
                  <Trans>Routines</Trans>
                )
              }
              action={
                routineCount > 0 ? (
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    data-testid="routine-create-button"
                    aria-label={t`Create routine`}
                    onClick={routines.onCreate}
                  >
                    <Plus className="size-4" />
                  </Button>
                ) : null
              }
            >
              <RoutineList {...routines} preview />
            </PanelSection>
          ) : null}
          <PagesList botId={bot.id} preview={{ onOpenAll: () => onViewChange?.("pages") }} />
        </div>
        <ErrorBoundary fallback={<SectionLoadFailed />}>
          <Suspense fallback={null}>
            <ScratchpadSection botId={bot.id} />
          </Suspense>
        </ErrorBoundary>
        <div className="mt-6" data-testid="bot-settings-advanced">
          <SectionHeading variant="label" className="flex min-h-6 items-center">
            <button
              type="button"
              aria-expanded={settingsOpen}
              aria-controls={`${ids}-settings`}
              onClick={() => setSettingsOpen((open) => !open)}
              className="-my-2 flex min-h-10 w-full items-center gap-1 rounded-sm outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Trans>Settings</Trans>
              <ChevronDown
                aria-hidden="true"
                className={`size-3.5 transition-transform ${settingsOpen ? "rotate-180" : ""}`}
              />
            </button>
          </SectionHeading>
          {/* Stays mounted so an instructions or description draft survives folding it away. */}
          <div id={`${ids}-settings`} hidden={!settingsOpen} className="space-y-6 pt-2">
            <SettingsCard>
              <ExecutionModelSection
                botId={bot.id}
                ids={ids}
                containerRef={modelRef}
                choices={modelChoices}
                value={selectedModelKey}
                onModelChange={(key) => {
                  setModelKey(key);
                  setThinkingLevel("");
                }}
                thinkingOptions={thinkingOptions}
                thinkingLevel={thinkingLevel}
                defaultThinkingLevel={defaultThinkingLevel}
                onThinkingLevelChange={setThinkingLevel}
              />
              <SwitchRow
                id={`${ids}-notify-finish`}
                label={<Trans>Notifications</Trans>}
                checked={notifyOnFinish}
                onChange={(checked) => {
                  setNotifyOnFinish(checked);
                  void enqueueSave({ notifyOnFinish: checked });
                }}
              />
              <SwitchRow
                id={`${ids}-own-computer`}
                label={<Trans>Own computer</Trans>}
                checked={computerMode === "dedicated"}
                disabled={saving}
                onChange={(checked) => setComputerMode(checked ? "dedicated" : "team")}
              />
              {/* Read only once the settings are open: listing versions reads object storage. */}
              {settingsOpen ? <ComputerHomeVersions botId={bot.id} /> : null}
              {changed.readAloud ? (
                <SwitchRow
                  id={`${ids}-auto-speak`}
                  label={<Trans>Read replies aloud</Trans>}
                  checked={autoSpeak}
                  onChange={setAutoSpeak}
                />
              ) : null}
              {changed.readAloud && voices?.length ? (
                <VoiceRow
                  ids={ids}
                  voices={voices}
                  voiceId={voiceId}
                  onVoiceIdChange={setVoiceId}
                />
              ) : null}
              {changed.dailyCheckIns ? (
                <SwitchRow
                  id={`${ids}-daily-check-ins`}
                  label={<Trans>Daily check-ins on unfinished work</Trans>}
                  checked={dailyCheckIns}
                  disabled={saving}
                  onChange={(checked) => {
                    setDailyCheckIns(checked);
                    void enqueueSave({ dailyCheckIns: checked });
                  }}
                />
              ) : null}
              {changed.crossSpaceCommunication ? (
                <SwitchRow
                  id={`${ids}-cross-space`}
                  label={<Trans>Allow cross-space bot communication</Trans>}
                  checked={crossSpaceCommunication}
                  disabled={saving}
                  onChange={(checked) => {
                    setCrossSpaceCommunication(checked);
                    void enqueueSave({ crossSpaceCommunication: checked });
                  }}
                />
              ) : null}
              {changed.fleetManagement ? (
                <SwitchRow
                  id={`${ids}-fleet-management`}
                  label={<Trans>Manage other bots</Trans>}
                  checked={fleetManagement}
                  disabled={saving}
                  onChange={(checked) => {
                    setFleetManagement(checked);
                    void enqueueSave({ fleetManagement: checked });
                  }}
                />
              ) : null}
            </SettingsCard>
            <InstructionSettings key={bot.id} bot={bot} />
            <ErrorBoundary fallback={<SectionLoadFailed />}>
              <Suspense fallback={null}>
                <KnowledgeSection botId={bot.id} />
              </Suspense>
            </ErrorBoundary>
            <DescriptionGroup
              ids={ids}
              description={description}
              onDescriptionChange={setDescription}
              onCommit={() => void enqueueSave()}
            />
            {changed.tools ? (
              <ToolsGroup
                ids={ids}
                disabledBuiltinTools={disabledBuiltinTools}
                onDisable={disableBuiltinTool}
                onEnable={(toolName) => {
                  const next = disabledBuiltinTools.filter((entry) => entry !== toolName);
                  setDisabledBuiltinTools(next);
                  void enqueueSave({ disabledBuiltinTools: next });
                }}
              />
            ) : null}
          </div>
        </div>
        {error ? <p className="mt-2 text-body-sm text-destructive">{error}</p> : null}
      </div>
    </div>
  );
}

const NO_CREDENTIALS: never[] = [];
const NO_CATALOG: ModelCatalogEntry[] = [];

function sameStringList(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function InlineProfileField({
  label,
  editLabel,
  value,
  maxLength,
  className,
  onCommit,
}: {
  label: string;
  editLabel: string;
  value: string;
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
        if (event.nativeEvent.isComposing || event.keyCode === 229) {
          if (event.key === "Escape") event.stopPropagation();
          return;
        }
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
      {value}
    </button>
  );
}
