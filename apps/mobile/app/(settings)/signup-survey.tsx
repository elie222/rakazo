import type { SignupSurvey as SignupSurveyAnswers } from "@rakazo/contracts";
import { signupSurveyAsksTeamSize } from "@rakazo/contracts";

import { useRef, useState } from "react";
import {
  KeyboardAvoidingView,
  Platform,
  ScrollView,
  StyleSheet,
  TextInput,
  View,
} from "react-native";
import { MenuPickerMenu } from "../../components/menu-picker";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSymbol } from "../../components/native-symbol";
import { SettingsGroup, SettingsRow, useStackedSettings } from "../../components/settings-group";
import { rpc } from "../../lib/api";
import { useI18n } from "../../lib/i18n";
import { native, useThemedStyles } from "../../lib/native";
import { closeSettingsSheet } from "../../lib/settings-sheet";
import { useSideInsets } from "../../lib/side-insets";
import type { SignupSurveyTeamSize } from "../../lib/signup-survey";
import { SIGNUP_SURVEY_TEAM_SIZE_CHOICES, signupSurveyAnswers } from "../../lib/signup-survey";

type Use = NonNullable<SignupSurveyAnswers["use"]>;

/** Optional questions shown once after signing up on a billing deployment. */
export default function SignupSurvey() {
  const sideInsets = useSideInsets();
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const stacked = useStackedSettings();
  const [reason, setReason] = useState("");
  const [use, setUse] = useState<Use>();
  const [teamSize, setTeamSize] = useState<SignupSurveyTeamSize>();
  const [source, setSource] = useState("");
  const finished = useRef(false);
  const uses: { key: Use; label: string }[] = [
    { key: "personal", label: t("Personal") },
    { key: "work", label: t("Work") },
    { key: "both", label: t("Both") },
  ];

  function finish() {
    if (finished.current) return;
    finished.current = true;
    // Answers are optional, so a slow or failed save never holds up the new account.
    void rpc(
      "onboarding/signupSurvey",
      signupSurveyAnswers({ reason, use, teamSize, source }),
    ).catch(() => undefined);
    closeSettingsSheet();
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === "ios" ? "padding" : undefined}
      style={styles.screen}
    >
      <ScrollView
        style={sideInsets}
        contentContainerStyle={[styles.content, stacked && styles.compactContent]}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        <SettingsGroup>
          <ChoiceRow
            choices={uses}
            label={t("How will you use Rakazo?")}
            onChange={setUse}
            value={use}
          />
          {signupSurveyAsksTeamSize(use) ? (
            <ChoiceRow
              choices={SIGNUP_SURVEY_TEAM_SIZE_CHOICES}
              label={t("How big is your team?")}
              onChange={setTeamSize}
              value={teamSize}
            />
          ) : null}
        </SettingsGroup>
        <SettingsGroup label={t("How did you hear about us?")}>
          <TextInput
            accessibilityLabel={t("How did you hear about us?")}
            maxLength={500}
            onChangeText={setSource}
            style={styles.input}
            value={source}
          />
        </SettingsGroup>
        <SettingsGroup label={t("What do you most want Rakazo to help with?")}>
          <TextInput
            accessibilityLabel={t("What do you most want Rakazo to help with?")}
            maxLength={2000}
            multiline
            onChangeText={setReason}
            placeholder={t("Optional")}
            placeholderTextColor={native.tertiaryLabel}
            style={[styles.input, styles.multiline]}
            textAlignVertical="top"
            value={reason}
          />
        </SettingsGroup>
        <NativeActionButton label={t("Continue")} onPress={finish} />
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

/** A native menu row that stays blank until the user picks, so nothing is chosen for them. */
function ChoiceRow<T extends string>({
  label,
  choices,
  value,
  onChange,
}: {
  label: string;
  choices: readonly { key: T; label: string }[];
  value: T | undefined;
  onChange: (value: T) => void;
}) {
  return (
    <MenuPickerMenu
      choices={choices}
      label={label}
      onChange={(key) => {
        const match = choices.find((choice) => choice.key === key);
        if (match) onChange(match.key);
      }}
      value={value ?? ""}
    >
      <View>
        <SettingsRow
          accessibilityLabel={label}
          accessibilityRole="button"
          accessible
          title={label}
          trailing={
            <NativeSymbol
              android="chevron-expand"
              color={native.tertiaryLabel}
              ios="chevron.up.chevron.down"
              size={13}
            />
          }
          value={choices.find((choice) => choice.key === value)?.label}
        />
      </View>
    </MenuPickerMenu>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32, gap: 28 },
    compactContent: { paddingHorizontal: 8 },
    input: {
      minHeight: 48,
      paddingHorizontal: 16,
      paddingVertical: 12,
      color: native.label,
      fontSize: 16,
    },
    multiline: { minHeight: 96 },
  });
}
