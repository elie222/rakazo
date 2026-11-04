import type { Routine } from "@rakazo/contracts";
import { defaultCronPreset } from "@rakazo/core";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, ScrollView, Text, View } from "react-native";
import { glassHeaderOptions } from "../components/glass-title";
import { GrowingTextInput } from "../components/growing-text-input";
import { NativeActionButton } from "../components/native-action-button";
import { RoutineRunHistory } from "../components/routine-run-history";
import { RoutineScheduleEditor } from "../components/routine-schedule-editor";
import {
  SettingsGroup,
  SettingsInputRow,
  SettingsLabel,
  SettingsRow,
  SettingsSwitch,
} from "../components/settings-group";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { deviceTimeZone, routineStatusLine, routineTriggerNames } from "../lib/routine";
import type { RoutineDraft } from "../lib/routine-draft";
import {
  draftFromRoutine,
  emptyRoutineDraft,
  routineDraftChanged,
  routineSaveRequest,
  routineScheduleLocked,
} from "../lib/routine-draft";
import { removeBotRoutine, saveBotRoutine, useBotRoutines } from "../lib/routine-store";
import { useSideInsets } from "../lib/side-insets";
import { errorText } from "../lib/user-error";

export default function RoutineDetail() {
  const sideInsets = useSideInsets();
  const tokens = useMobileTokens();
  const { t } = useI18n();
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
  const creating = Boolean(botId) && !routineId;
  const routine = routines?.find((item) => item.id === routineId) ?? null;
  const error = !botId
    ? t("Routine link is incomplete")
    : creating || routine
      ? null
      : failedSinceShown
        ? errorText(loadError, t("Could not load routine"))
        : readSinceShown
          ? t("This routine no longer exists")
          : null;
  const loading = !creating && !routine && !error;
  const editable = creating || (routine !== null && routine.editable !== false);

  return (
    <ScrollView
      style={[{ flex: 1, backgroundColor: tokens.background }, sideInsets]}
      contentContainerStyle={{ padding: 24, gap: 18 }}
      contentInsetAdjustmentBehavior="automatic"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      <Stack.Screen
        options={glassHeaderOptions(creating ? t("New routine") : (routine?.name ?? t("Routine")))}
      />
      {loading ? <ActivityIndicator color={tokens.mutedForeground} /> : null}
      {error ? <Text style={{ color: tokens.destructive, fontSize: 15 }}>{error}</Text> : null}
      {botId && editable ? (
        <RoutineEditor
          // A new routine becomes an edit once saved; the draft carries over.
          key={botId}
          botId={botId}
          routine={routine}
          onCreated={(saved) => router.setParams({ routineId: saved.id })}
          onDeleted={() => router.back()}
        />
      ) : routine ? (
        <RoutineSummary routine={routine} />
      ) : null}
      {routine && origin !== "profile" ? (
        <NativeActionButton
          label={t("Open conversation")}
          prominence="secondary"
          onPress={() =>
            router.push({
              pathname: "/thread",
              params: { botId: botId ?? "", name: botName ?? t("Bot") },
            })
          }
        />
      ) : null}
      {routine ? <RoutineRunHistory routineId={routine.id} botName={botName} /> : null}
    </ScrollView>
  );
}

/** Read-only, for a routine another Space member created. */
function RoutineSummary({ routine }: { routine: Routine }) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  return (
    <>
      <View style={{ borderRadius: 16, backgroundColor: native.fill, padding: 18 }}>
        <Text style={{ color: tokens.mutedForeground, fontSize: 14 }}>
          {routineStatusLine(routine)}
        </Text>
      </View>
      <View style={{ gap: 8 }}>
        <SettingsLabel>{t("Prompt")}</SettingsLabel>
        <Text
          selectable
          style={{
            color: tokens.foreground,
            fontSize: 15,
            lineHeight: 23,
            borderRadius: 16,
            backgroundColor: native.fill,
            padding: 18,
          }}
        >
          {routine.prompt}
        </Text>
      </View>
    </>
  );
}

function RoutineEditor({
  botId,
  routine,
  onCreated,
  onDeleted,
}: {
  botId: string;
  routine: Routine | null;
  onCreated: (routine: Routine) => void;
  onDeleted: () => void;
}) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const [draft, setDraft] = useState<RoutineDraft>(() =>
    routine ? draftFromRoutine(routine) : emptyRoutineDraft(),
  );
  // The routine the draft was taken from. A poll that brings a newer copy refreshes the draft
  // only while nothing is edited, so a change made elsewhere shows without losing typing.
  const [base, setBase] = useState<Routine | null>(routine);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const busy = useRef(false);
  const dirty = routineDraftChanged(draft, base);

  useEffect(() => {
    if (!routine || routine === base) return;
    if (!dirty) setDraft(draftFromRoutine(routine));
    setBase(routine);
  }, [routine, base, dirty]);

  const locked = routineScheduleLocked(base);
  const otherTriggers = base ? routineTriggerNames(base) : [];

  function update(partial: Partial<RoutineDraft>) {
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
          ? t("Name this routine.")
          : request.error === "prompt"
            ? t("Write what this routine should do.")
            : t("Add a schedule to run this routine."),
      );
      return;
    }
    if ("unchanged" in request) return;
    busy.current = true;
    setSaving(true);
    setSaveError(null);
    try {
      const saved = await saveBotRoutine(botId, request);
      // Typing during the save is kept; it stays to save against the new copy.
      setDraft((current) => (current === draft ? draftFromRoutine(saved) : current));
      setBase(saved);
      if ("create" in request) onCreated(saved);
    } catch (cause) {
      setSaveError(errorText(cause, t("Could not save routine")));
    } finally {
      busy.current = false;
      setSaving(false);
    }
  }

  async function testRun() {
    if (!base || busy.current) return;
    busy.current = true;
    setRunning(true);
    setSaveError(null);
    try {
      await rpc("routines/testRun", { routineId: base.id });
    } catch (cause) {
      setSaveError(errorText(cause, t("Could not run routine")));
    } finally {
      busy.current = false;
      setRunning(false);
    }
  }

  function confirmDelete() {
    const target = base;
    if (!target || busy.current) return;
    Alert.alert(
      target.name.trim() ? t('Delete "{name}"?', { name: target.name }) : t("Delete this routine?"),
      t("This permanently deletes the routine and its run history."),
      [
        { text: t("Cancel"), style: "cancel" },
        {
          text: t("Delete"),
          style: "destructive",
          onPress: () => {
            busy.current = true;
            void removeBotRoutine(botId, target.id)
              .then(onDeleted)
              .catch((cause) =>
                Alert.alert(t("Could not delete routine"), errorText(cause, t("Try again."))),
              )
              .finally(() => {
                busy.current = false;
              });
          },
        },
      ],
    );
  }

  return (
    <>
      <SettingsGroup>
        <SettingsInputRow
          key="name"
          accessibilityLabel={t("Name")}
          placeholder={t("Name")}
          maxLength={80}
          value={draft.name}
          onChangeText={(name) => update({ name })}
        />
      </SettingsGroup>
      <View style={{ gap: 7 }}>
        <SettingsLabel>{t("Instruction")}</SettingsLabel>
        <GrowingTextInput
          label={t("Instruction")}
          value={draft.prompt}
          onChangeText={(prompt) => update({ prompt })}
          backgroundColor={native.groupedCell}
        />
      </View>
      {locked && base ? (
        <SettingsGroup label={t("When to run")}>
          <SettingsRow key="once" title={routineStatusLine(base)} />
        </SettingsGroup>
      ) : (
        <>
          {draft.schedules.map((schedule, index) => (
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
          <SettingsGroup label={draft.schedules.length ? undefined : t("When to run")}>
            {otherTriggers.map((name) => (
              <SettingsRow key={name} title={name} />
            ))}
            {/* A change trigger checks on its own interval, so it never shares a schedule. */}
            {base?.watch ? null : (
              <SettingsRow
                key="add"
                accessibilityRole="button"
                tinted
                title={t("Add schedule")}
                onPress={() => update({ schedules: [...draft.schedules, defaultCronPreset()] })}
              />
            )}
          </SettingsGroup>
        </>
      )}
      <SettingsGroup
        footer={routine?.active && routine.scheduleDelayed ? t("Schedule delayed") : undefined}
      >
        <SettingsSwitch
          key="active"
          label={t("Active")}
          value={draft.active}
          onChange={(active) => update({ active })}
        />
      </SettingsGroup>
      {saveError ? (
        <Text style={{ color: tokens.destructive, fontSize: 15 }}>{saveError}</Text>
      ) : null}
      {dirty ? (
        <NativeActionButton
          label={saving ? t("Saving…") : t("Save")}
          busy={saving}
          onPress={() => void save()}
        />
      ) : base ? (
        <NativeActionButton
          label={t("Test run")}
          prominence="secondary"
          busy={running}
          onPress={() => void testRun()}
        />
      ) : null}
      {base ? (
        <SettingsGroup>
          <SettingsRow
            key="delete"
            accessibilityRole="button"
            destructive
            title={t("Delete routine")}
            onPress={confirmDelete}
          />
        </SettingsGroup>
      ) : null}
    </>
  );
}
