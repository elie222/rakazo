import type { BotPackageReceipt, BotPackageSkillReceipt } from "@rakazo/contracts";
import { useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native } from "../lib/native";
import { NativeActionButton } from "./native-action-button";

function SkillRow({
  skill,
  disabled,
  onActivate,
}: {
  skill: BotPackageSkillReceipt;
  disabled: boolean;
  onActivate(name: string): void;
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(skill.name);
  return (
    <View style={styles.section}>
      <NativeActionButton
        label={skill.name}
        selected={open}
        prominence="quiet"
        onPress={() => setOpen(!open)}
      />
      <Text style={styles.secondary}>
        {skill.status === "activated"
          ? t("Enabled")
          : skill.status === "removed"
            ? t("Removed")
            : t("Pending")}
      </Text>
      {open ? (
        <>
          <Text selectable style={styles.raw}>
            {skill.content}
          </Text>
          {skill.status === "pending" ? (
            <>
              <Text style={styles.text}>{t("Skill name")}</Text>
              <TextInput
                accessibilityLabel={t("Skill name")}
                value={name}
                maxLength={80}
                editable={!disabled}
                onChangeText={setName}
                autoCapitalize="none"
                autoCorrect={false}
                style={styles.input}
              />
              <NativeActionButton
                label={t("Enable shared skill")}
                disabled={disabled || !name.trim()}
                onPress={() => onActivate(name.trim())}
                prominence="secondary"
              />
            </>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

export function BotPackageSkillsView({
  receipt,
  busy,
  unknown,
  error,
  onActivate,
  onRefresh,
}: {
  receipt: BotPackageReceipt;
  busy: boolean;
  unknown: boolean;
  error: boolean;
  onActivate(componentId: string, name: string): void;
  onRefresh(): void;
}) {
  const { t } = useI18n();
  if (!receipt.skills.length) return null;
  return (
    <View style={styles.section} testID="bot-package-skills">
      <Text style={styles.heading}>{t("Imported skills")}</Text>
      <Text style={styles.secondary}>
        {t("Enabling a skill shares it with your bots in this space.")}
      </Text>
      {error ? (
        <Text accessibilityRole="alert" style={styles.secondary}>
          {t("Could not enable skill. Check status or choose another name.")}
        </Text>
      ) : null}
      {receipt.skills.map((skill) => (
        <SkillRow
          key={`${skill.id}:${skill.revision}`}
          skill={skill}
          disabled={busy || unknown || receipt.status !== "completed"}
          onActivate={(name) => onActivate(skill.id, name)}
        />
      ))}
      {unknown || error ? (
        <NativeActionButton
          label={t("Check status")}
          disabled={busy}
          onPress={onRefresh}
          prominence="secondary"
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 12 },
  heading: { fontSize: 16, fontWeight: "600", color: native.label },
  text: { fontSize: 14, color: native.label },
  secondary: { fontSize: 14, color: native.secondaryLabel },
  raw: {
    fontSize: 13,
    color: native.label,
    backgroundColor: native.fill,
    padding: 12,
    borderRadius: 10,
  },
  input: {
    fontSize: 14,
    color: native.label,
    backgroundColor: native.fill,
    padding: 12,
    borderRadius: 10,
  },
});
