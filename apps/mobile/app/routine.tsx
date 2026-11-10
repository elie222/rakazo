import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { Routine } from "@rakazo/contracts";
import { defaultCronPreset, draftFromRoutine, emptyRoutineDraft } from "@rakazo/core";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, BackHandler, ScrollView, Text, View } from "react-native";
import { useBotEmail } from "../components/bot-email";
import { GlassIconButton } from "../components/glass-icon-button";
import { GrowingTextInput } from "../components/growing-text-input";
import { MenuPickerMenu } from "../components/menu-picker";
import { NativeActionButton } from "../components/native-action-button";
import { RoutineEmailTrigger } from "../components/routine-email-trigger";
import { RoutineScheduleEditor } from "../components/routine-schedule-editor";
import {
  SettingsGroup,
  SettingsInputRow,
  SettingsLabel,
  SettingsRow,
  SettingsSwitch,
} from "../components/settings-group";
import { rpc } from "../lib/api";
import { dateLocaleForUi, useUiLocale } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { iosAtLeast } from "../lib/native-controls";
import { deviceTimeZone, routineTriggerRows, routineWebTriggers } from "../lib/routine";
import type { MobileRoutineDraft } from "../lib/routine-draft";
import {
  routineDraftChanged,
  routineSaveRequest,
  routineScheduleLocked,
  routineWithDraftTriggers,
} from "../lib/routine-draft";
import {
  removeBotRoutine,
  saveBotRoutine,
  setRoutineActive,
  useBotRoutines,
} from "../lib/routine-store";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

export default function RoutineDetail() {
  const sideInsets = useSideInsets();
  const tokens = useMobileTokens();
  const { t } = useLingui();
  const { botId, botName, routineId, origin } = useLocalSearchParams<{
    botId?: string;
    botName?: string;
    routineId?: string;
    origin?: string;
  }>();
  const router = useRouter();
  // Opened from the list, the routine is already known; it still reads again. A routine missing
  // from what was known before only counts as gone once that read answers.
  const {
    routines,
    error: loadError,
    readSinceShown,
    failedSinceShown,
  } = useBotRoutines(botId ?? "");
  const [editing, setEditing] = useState(false);
  const creating = Boolean(botId) && !routineId;
  const routine = routines?.find((item) => item.id === routineId) ?? null;
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
      automaticallyAdjustKeyboardInsets
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
          onCancel={() => setEditing(false)}
          onSaved={(saved) => {
            if (creating) router.setParams({ routineId: saved.id });
            setEditing(false);
          }}
          onDeleted={() => router.back()}
        />
      ) : botId && routine ? (
        <RoutineView
          botId={botId}
          botName={botName}
          routine={routine}
          editable={editable}
          showConversation={origin !== "profile"}
          onEdit={() => setEditing(true)}
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
}: {
  botId: string;
  botName: string | undefined;
  routine: Routine;
  editable: boolean;
  showConversation: boolean;
  onEdit: () => void;
}) {
  const tokens = useMobileTokens();
  const { t } = useLingui();
  const locale = useUiLocale();
  const router = useRouter();
  const [running, setRunning] = useState(false);
  const triggers = routineTriggerRows(routine, deviceTimeZone());
  const nextRun =
    !routine.active || !routine.nextRunAt
      ? null
      : routine.scheduleDelayed
        ? t`Schedule delayed`
        : new Date(routine.nextRunAt).toLocaleString(dateLocaleForUi(locale), {
            weekday: "short",
            month: "short",
            day: "numeric",
            hour: "numeric",
            minute: "2-digit",
          });

  async function testRun() {
    if (running) return;
    setRunning(true);
    try {
      await rpc("routines/testRun", { routineId: routine.id });
    } catch (cause) {
      Alert.alert(t`Could not run routine`, errorText(cause, t`Try again.`));
    } finally {
      setRunning(false);
    }
  }

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
          ...(editable
            ? iosAtLeast(26)
              ? {
                  unstable_headerRightItems: () => [
                    {
                      type: "button" as const,
                      label: t`Run now`,
                      icon: { type: "sfSymbol" as const, name: "play" },
                      disabled: running,
                      onPress: () => void testRun(),
                    },
                  ],
                }
              : {
                  headerRight: () => (
                    <GlassIconButton
                      accessibilityLabel={t`Run now`}
                      ios="play"
                      android="play"
                      disabled={running}
                      onPress={() => void testRun()}
                    />
                  ),
                }
            : {}),
        }}
      />
      <SettingsGroup>
        <SettingsSwitch
          key="active"
          label={t`Active`}
          value={routine.active}
          // Only the routine's creator can pause or resume it.
          disabled={!editable}
          onChange={(active) =>
            setRoutineActive(botId, routine, active, (cause) =>
              Alert.alert(t`Could not update routine`, errorText(cause, t`Try again.`)),
            )
          }
        />
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
      ) : null}
    </>
  );
}

/** The form for a new routine, or for one opened with Edit. Save and Cancel live in the header. */
function RoutineEditor({
  botId,
  botName,
  routine,
  onCancel,
  onSaved,
  onDeleted,
}: {
  botId: string;
  botName: string;
  routine: Routine | null;
  onCancel: () => void;
  onSaved: (routine: Routine) => void;
  onDeleted: () => void;
}) {
  const tokens = useMobileTokens();
  const { t } = useLingui();
  // The routine as it was when Edit opened; a save sends only what changed since.
  const [base] = useState(routine);
  const [draft, setDraft] = useState<MobileRoutineDraft>(() =>
    base ? draftFromRoutine(base) : emptyRoutineDraft(),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const busy = useRef(false);
  const email = useBotEmail(botId);
  const dirty = routineDraftChanged(draft, base);
  const locked = routineScheduleLocked(base);
  // Triggers set up on web stay listed here so the person sees them and can remove them.
  const kept = base ? routineWithDraftTriggers(base, draft) : null;
  const webTriggers = kept ? routineWebTriggers(kept) : [];

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
    const timezone = base?.timezone ?? deviceTimeZone() ?? "UTC";
    const request = routineSaveRequest(draft, base, botId, timezone);
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
          maxLength={80}
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
                  onPress={() => update({ emailSenders: "owner" })}
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
