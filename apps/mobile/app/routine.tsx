import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Routine } from "@rakazo/contracts";
import { ROUTINE_NAME_MAX_LENGTH } from "@rakazo/contracts";
import {
  cronFromPreset,
  defaultCronPreset,
  defaultRoutineEndDay,
  draftFromRoutine,
  emptyRoutineDraft,
  formatRoutineEnd,
  isOneShotRoutineCrons,
  routineCanEnd,
  routineCopy,
  wallClock,
} from "@rakazo/core";
import { Stack, useFocusEffect, useLocalSearchParams, useRouter } from "expo-router";
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { ActivityIndicator, Alert, BackHandler, ScrollView, Text, View } from "react-native";
import { useBotEmail } from "../components/bots/bot-email";
import { GlassIconButton } from "../components/native/glass-icon-button";
import { NativeActionButton } from "../components/native/native-action-button";
import { RoutineEmailTrigger } from "../components/routines/routine-email-trigger";
import { RoutineEndDate } from "../components/routines/routine-end-date";
import { RoutineScheduleEditor } from "../components/routines/routine-schedule-editor";
import {
  SettingsGroup,
  SettingsInputRow,
  SettingsLabel,
  SettingsRow,
  SettingsSwitch,
} from "../components/settings/settings-group";
import { GrowingTextInput } from "../components/ui/growing-text-input";
import { MenuPickerMenu } from "../components/ui/menu-picker";
import { errorText } from "../lib/api/user-error";
import { CallKeyboardContext } from "../lib/calls/call-keyboard-context";
import { useDateLocale } from "../lib/i18n/i18n";
import { useSideInsets } from "../lib/layout/side-insets";
import { native, useMobileTokens } from "../lib/native/native";
import { iosAtLeast } from "../lib/native/native-controls";
import { useSave } from "../lib/query/query";
import { deviceTimeZone, routineTriggerRows, routineWebTriggers } from "../lib/routines/routine";
import type { MobileRoutineDraft } from "../lib/routines/routine-draft";
import {
  routineDraftChanged,
  routineDraftEventTriggered,
  routineSaveRequest,
  routineScheduleLocked,
  routineWithDraftTriggers,
} from "../lib/routines/routine-draft";
import {
  removeBotRoutine,
  saveBotRoutine,
  setRoutineActive,
  useBotRoutines,
} from "../lib/routines/routine-store";

export default function RoutineDetail() {
  const rootAvoidsKeyboard = useContext(CallKeyboardContext);
  const sideInsets = useSideInsets();
  const tokens = useMobileTokens();
  const { t } = useLingui();
  const { botId, botName, routineId, origin, copyOf } = useLocalSearchParams<{
    botId?: string;
    botName?: string;
    routineId?: string;
    origin?: string;
    /** A new routine that starts as a copy of this one, usually another member's. */
    copyOf?: string;
  }>();
  const router = useRouter();
  const deletionContext = useMemo(() => ({ active: false }), [botId, routineId]);
  useFocusEffect(
    useCallback(() => {
      deletionContext.active = true;
      return () => {
        deletionContext.active = false;
      };
    }, [deletionContext]),
  );
  // Opened from the list, the routine is already known; it still reads again. A routine missing
  // from what was known before only counts as gone once that read answers.
  const {
    routines,
    error: loadError,
    readSinceShown,
    failedSinceShown,
  } = useBotRoutines(botId ?? "");
  const [editing, setEditing] = useState(false);
  const routine = routines?.find((item) => item.id === routineId) ?? null;
  const copySource = (copyOf && routines?.find((item) => item.id === copyOf)) || null;
  const template = copySource
    ? routineCopy(copySource, t`${ph({ name: copySource.name })} (copy)`)
    : null;
  // A copy waits for the routine it copies, so its form never starts empty.
  const creating = Boolean(botId) && !routineId && (!copyOf || template !== null);
  const error = !botId
    ? t`Routine link is incomplete`
    : creating || routine
      ? null
      : failedSinceShown
        ? errorText(loadError, t`Could not load routine`)
        : readSinceShown
          ? t`This routine no longer exists`
          : null;
  const loading = !creating && !routine && !error;
  const editable = creating || (routine !== null && routine.editable !== false);

  return (
    <ScrollView
      style={[{ flex: 1, backgroundColor: native.groupedPage }, sideInsets]}
      contentContainerStyle={{ padding: 24, gap: 24 }}
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustKeyboardInsets={!rootAvoidsKeyboard}
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      {loading || error ? <Stack.Screen options={{ title: t`Routine` }} /> : null}
      {loading ? <ActivityIndicator color={tokens.mutedForeground} /> : null}
      {error ? <Text style={{ color: tokens.destructive, fontSize: 15 }}>{error}</Text> : null}
      {botId && editable && (creating || editing) ? (
        <RoutineEditor
          botId={botId}
          botName={botName ?? ""}
          routine={routine}
          template={template}
          onCancel={() => setEditing(false)}
          onSaved={(saved) => {
            if (creating) router.setParams({ routineId: saved.id });
            setEditing(false);
          }}
          onDeleted={() => {
            if (deletionContext.active) router.back();
          }}
        />
      ) : botId && routine ? (
        <RoutineView
          botId={botId}
          botName={botName}
          routine={routine}
          editable={editable}
          showConversation={origin !== "profile"}
          onEdit={() => setEditing(true)}
          onCopy={() =>
            router.push({
              pathname: "/routine",
              params: { botId, botName: botName ?? "", copyOf: routine.id },
            })
          }
        />
      ) : null}
    </ScrollView>
  );
}

/** What the routine does and when, with the switch first; changing it is behind Edit. */
function RoutineView({
  botId,
  botName,
  routine,
  editable,
  showConversation,
  onEdit,
  onCopy,
}: {
  botId: string;
  botName: string | undefined;
  routine: Routine;
  /** False for another member's routine: only its owner changes it, anyone may turn it on or off. */
  editable: boolean;
  showConversation: boolean;
  onEdit: () => void;
  onCopy: () => void;
}) {
  const tokens = useMobileTokens();
  const { t } = useLingui();
  const dateLocale = useDateLocale();
  const router = useRouter();
  const testRun = useSave({
    save: (_, send) => send("routines/testRun", { routineId: routine.id }),
    onFailed: (cause) => Alert.alert(t`Could not run routine`, errorText(cause, t`Try again.`)),
  });
  const triggers = routineTriggerRows(routine, deviceTimeZone());
  const nextRun =
    !routine.active || !routine.nextRunAt
      ? null
      : routine.scheduleDelayed
        ? t`Schedule delayed`
        : new Date(routine.nextRunAt).toLocaleString(dateLocale, {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          });

  return (
    <>
      <Stack.Screen
        options={{
          title: routine.name,
          // Header options persist on the screen, so undo what the form set.
          headerBackVisible: true,
          gestureEnabled: true,
          headerLeft: undefined,
          headerRight: undefined,
          unstable_headerLeftItems: undefined,
          unstable_headerRightItems: undefined,
          ...(iosAtLeast(26)
            ? {
                unstable_headerRightItems: () => [
                  {
                    type: "button" as const,
                    label: t`Run now`,
                    icon: { type: "sfSymbol" as const, name: "play" },
                    disabled: testRun.pending,
                    onPress: () => testRun.run(),
                  },
                ],
              }
            : {
                headerRight: () => (
                  <GlassIconButton
                    accessibilityLabel={t`Run now`}
                    ios="play"
                    android="play"
                    disabled={testRun.pending}
                    onPress={() => testRun.run()}
                  />
                ),
              }),
        }}
      />
      <SettingsGroup>
        <SettingsSwitch
          key="active"
          label={t`Active`}
          value={routine.active}
          onChange={(active) =>
            setRoutineActive(botId, routine, active, (cause) =>
              Alert.alert(t`Could not update routine`, errorText(cause, t`Try again.`)),
            )
          }
        />
        {routine.runsAs && !routine.runsAs.isViewer ? (
          <SettingsRow key="owner" title={t`Owner`} value={routine.runsAs.name} />
        ) : null}
      </SettingsGroup>
      <View style={{ gap: 7 }}>
        <SettingsLabel>{t`Instruction`}</SettingsLabel>
        <Text
          selectable
          style={{
            color: tokens.foreground,
            fontSize: 17,
            lineHeight: 24,
            borderRadius: 16,
            borderCurve: "continuous",
            overflow: "hidden",
            backgroundColor: native.groupedCell,
            padding: 16,
          }}
        >
          {routine.prompt}
        </Text>
      </View>
      <SettingsGroup label={t`When to run`}>
        {triggers.map((trigger) => (
          <SettingsRow key={trigger} title={trigger} />
        ))}
        {nextRun ? <SettingsRow key="next" title={t`Next run`} value={nextRun} /> : null}
        {routine.endsAt ? (
          <SettingsRow
            key="ends"
            title={t`Ends`}
            value={formatRoutineEnd(routine.endsAt, routine.timezone, dateLocale)}
          />
        ) : null}
      </SettingsGroup>
      <SettingsGroup>
        <SettingsRow
          key="runs"
          accessibilityRole="button"
          title={t`Run history`}
          chevron="right"
          onPress={() =>
            router.push({ pathname: "/routine-runs", params: { routineId: routine.id, botName } })
          }
        />
        {showConversation ? (
          <SettingsRow
            key="thread"
            accessibilityRole="button"
            title={t`Open conversation`}
            chevron="right"
            onPress={() =>
              router.push({
                pathname: "/thread",
                params: { botId, name: botName ?? t`Bot` },
              })
            }
          />
        ) : null}
      </SettingsGroup>
      {editable ? (
        <SettingsGroup>
          <SettingsRow
            key="edit"
            accessibilityRole="button"
            tinted
            title={t`Edit routine`}
            onPress={onEdit}
          />
        </SettingsGroup>
      ) : isOneShotRoutineCrons(routine.crons) ? null : (
        // A one-time routine is set up from chat, so it has no copy here.
        <SettingsGroup>
          <SettingsRow
            key="copy"
            accessibilityRole="button"
            tinted
            title={t`Make a copy`}
            onPress={onCopy}
          />
        </SettingsGroup>
      )}
    </>
  );
}

/** The form for a new routine, or for one opened with Edit. Save and Cancel live in the header. */
function RoutineEditor({
  botId,
  botName,
  routine,
  template,
  onCancel,
  onSaved,
  onDeleted,
}: {
  botId: string;
  botName: string;
  routine: Routine | null;
  /** For a new routine: the one it starts as a copy of. */
  template: Routine | null;
  onCancel: () => void;
  onSaved: (routine: Routine) => void;
  onDeleted: () => void;
}) {
  const tokens = useMobileTokens();
  const { t } = useLingui();
  // The routine as it was when Edit opened; a save sends only what changed since.
  const [base] = useState(routine);
  const [draft, setDraft] = useState<MobileRoutineDraft>(() =>
    base ? draftFromRoutine(base) : template ? draftFromRoutine(template) : emptyRoutineDraft(),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const busy = useRef(false);
  const email = useBotEmail(botId);
  const dirty = routineDraftChanged(draft, base);
  const locked = routineScheduleLocked(base);
  // Triggers set up on web stay listed here so the person sees them and can remove them.
  const source = base ?? template;
  const kept = source ? routineWithDraftTriggers(source, draft) : null;
  const webTriggers = kept ? routineWebTriggers(kept) : [];
  const draftCrons = draft.schedules.map(cronFromPreset);
  const repeats =
    !locked &&
    routineCanEnd(draftCrons, Boolean(kept?.watch), routineDraftEventTriggered(draft, source));
  const zone = draft.timezone ?? deviceTimeZone() ?? "UTC";

  // On Android, back leaves the form for the routine instead of leaving the routine.
  useEffect(() => {
    if (!base) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      onCancel();
      return true;
    });
    return () => subscription.remove();
  }, [base, onCancel]);

  function update(partial: Partial<MobileRoutineDraft>) {
    setSaveError(null);
    setDraft((current) => ({ ...current, ...partial }));
  }

  async function save() {
    if (busy.current) return;
    const timezone = deviceTimeZone() ?? "UTC";
    const request = routineSaveRequest(draft, base, botId, timezone, template);
    if ("error" in request) {
      setSaveError(
        request.error === "name"
          ? t`Name this routine.`
          : request.error === "prompt"
            ? t`Write what this routine should do.`
            : t`Add a trigger to run this routine.`,
      );
      return;
    }
    if ("unchanged" in request) {
      onCancel();
      return;
    }
    busy.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      onSaved(await saveBotRoutine(botId, request));
    } catch (cause) {
      setSaveError(errorText(cause, t`Could not save routine`));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  function confirmDelete() {
    const target = base;
    if (!target || busy.current) return;
    Alert.alert(
      target.name.trim() ? t`Delete "${ph({ name: target.name })}"?` : t`Delete this routine?`,
      t`This permanently deletes the routine and its run history.`,
      [
        { text: t`Cancel`, style: "cancel" },
        {
          text: t`Delete`,
          style: "destructive",
          onPress: () => {
            busy.current = true;
            void removeBotRoutine(botId, target.id)
              .then(onDeleted)
              .catch((cause) =>
                Alert.alert(t`Could not delete routine`, errorText(cause, t`Try again.`)),
              )
              .finally(() => {
                busy.current = false;
              });
          },
        },
      ],
    );
  }

  // A newly added email trigger needs the bot's address first; the server refuses it without one.
  const awaitingAddress =
    Boolean(draft.emailSenders) && !base?.emailSenders && !email.address?.address;
  const canSave = dirty && !saving && !awaitingAddress;
  return (
    <>
      <Stack.Screen
        options={{
          title: base ? t`Edit routine` : t`New routine`,
          ...(base ? { headerBackVisible: false, gestureEnabled: false } : {}),
          headerLeft: base
            ? () => (
                <GlassIconButton
                  accessibilityLabel={t`Cancel`}
                  ios="xmark"
                  android="close"
                  onPress={onCancel}
                />
              )
            : undefined,
          headerRight: () => (
            <NativeActionButton
              label={t`Save`}
              size="compact"
              disabled={!canSave}
              busy={saving}
              onPress={() => void save()}
              style={{ borderRadius: 24 }}
            />
          ),
          ...(iosAtLeast(26)
            ? {
                ...(base
                  ? {
                      unstable_headerLeftItems: () => [
                        {
                          type: "button" as const,
                          label: t`Cancel`,
                          icon: { type: "sfSymbol" as const, name: "xmark" },
                          onPress: onCancel,
                        },
                      ],
                    }
                  : {}),
                unstable_headerRightItems: () => [
                  {
                    type: "button" as const,
                    label: t`Save`,
                    icon: { type: "sfSymbol" as const, name: "checkmark" },
                    variant: "prominent" as const,
                    tintColor: tokens.primary,
                    disabled: !canSave,
                    onPress: () => void save(),
                  },
                ],
              }
            : {}),
        }}
      />
      {saveError ? (
        <Text style={{ color: tokens.destructive, fontSize: 15 }}>{saveError}</Text>
      ) : null}
      <SettingsGroup>
        <SettingsInputRow
          key="name"
          accessibilityLabel={t`Name`}
          placeholder={t`Name`}
          maxLength={ROUTINE_NAME_MAX_LENGTH}
          value={draft.name}
          onChangeText={(name) => update({ name })}
        />
      </SettingsGroup>
      <View style={{ gap: 7 }}>
        <SettingsLabel>{t`Instruction`}</SettingsLabel>
        <GrowingTextInput
          label={t`Instruction`}
          value={draft.prompt}
          onChangeText={(prompt) => update({ prompt })}
          backgroundColor={native.groupedCell}
          fontSize={17}
        />
      </View>
      {/* A one-shot's schedule is fixed, but web triggers on it can still be removed. */}
      {locked && !webTriggers.length ? null : (
        <View style={{ gap: 12 }}>
          <SettingsLabel>{t`When to run`}</SettingsLabel>
          {locked
            ? null
            : draft.schedules.map((schedule, index) => (
                <RoutineScheduleEditor
                  // Schedules have no id. The rows keep no state of their own, so a position will do.
                  key={index}
                  value={schedule}
                  onChange={(next) =>
                    update({
                      schedules: draft.schedules.map((item, at) => (at === index ? next : item)),
                    })
                  }
                  onRemove={() =>
                    update({ schedules: draft.schedules.filter((_, at) => at !== index) })
                  }
                />
              ))}
          {webTriggers.length ? (
            <SettingsGroup>
              {webTriggers.map((trigger) => (
                <MenuPickerMenu
                  key={trigger.key}
                  label={trigger.label}
                  value=""
                  choices={[
                    {
                      key: "remove",
                      label: t`Remove ${ph({ name: trigger.label })}`,
                      destructive: true,
                    },
                  ]}
                  onChange={() =>
                    update(
                      trigger.key === "webhookEnabled" || trigger.key === "githubEnabled"
                        ? { [trigger.key]: false }
                        : { [trigger.key]: null },
                    )
                  }
                >
                  <SettingsRow
                    title={trigger.label}
                    accessible
                    accessibilityRole="button"
                    accessibilityLabel={trigger.label}
                  />
                </MenuPickerMenu>
              ))}
            </SettingsGroup>
          ) : null}
          {repeats ? (
            <RoutineEndDate
              endsOn={draft.endsOn}
              today={wallClock(new Date(), zone).slice(0, 10)}
              firstDay={defaultRoutineEndDay(draftCrons, zone)}
              onChange={(endsOn) => update({ endsOn })}
            />
          ) : null}
          {locked ? null : (
            <SettingsGroup>
              {/* A change trigger checks on its own interval, so it never shares a schedule. */}
              {kept?.watch ? null : (
                <SettingsRow
                  key="add"
                  accessibilityRole="button"
                  tinted
                  title={t`Add schedule`}
                  onPress={() => update({ schedules: [...draft.schedules, defaultCronPreset()] })}
                />
              )}
              {email.address && !draft.emailSenders ? (
                <SettingsRow
                  key="email"
                  accessibilityRole="button"
                  tinted
                  title={t`Add email trigger`}
                  // An email trigger's bot never gets the owner's computer.
                  onPress={() => update({ emailSenders: "owner", useComputer: undefined })}
                />
              ) : null}
            </SettingsGroup>
          )}
        </View>
      )}
      {draft.emailSenders ? (
        <RoutineEmailTrigger
          botId={botId}
          botName={botName}
          email={email}
          senders={draft.emailSenders}
          onChange={(emailSenders) => update({ emailSenders })}
          onRemove={() => update({ emailSenders: null })}
        />
      ) : null}
      {/* Only the owner, with a computer paired, sees it; a watch's runs never get the computer. */}
      {base?.useComputer !== undefined && !base.inChat && !kept?.watch && !draft.emailSenders ? (
        <SettingsGroup>
          <SettingsSwitch
            key="computer"
            label={t`Use my computer`}
            value={draft.useComputer ?? base.useComputer}
            onChange={(useComputer) => update({ useComputer })}
          />
        </SettingsGroup>
      ) : null}
      {base ? (
        <SettingsGroup>
          <SettingsRow
            key="delete"
            accessibilityRole="button"
            destructive
            title={t`Delete routine`}
            onPress={confirmDelete}
          />
        </SettingsGroup>
      ) : null}
    </>
  );
}
