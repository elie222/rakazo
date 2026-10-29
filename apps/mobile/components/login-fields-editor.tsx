import type { LoginFieldInput } from "@rakazo/contracts";
import { LOGIN_FIELD_LIMIT } from "@rakazo/contracts";
import type { RefObject } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { mobileTokens } from "../lib/appearance";
import { useI18n } from "../lib/i18n";
import { useThemedStyles } from "../lib/native";
import { loginFieldTraits } from "../lib/secret-field-traits";
import { NativeActionButton } from "./native-action-button";
import { NativeSwitch } from "./native-switch";

export type LoginFieldRow = LoginFieldInput & { id: number };

export function emptyLoginField(fields: readonly LoginFieldRow[]): LoginFieldRow {
  return {
    id: Math.max(-1, ...fields.map((field) => field.id)) + 1,
    label: "",
    value: "",
    hidden: true,
  };
}

/**
 * The values of a website login, each with a Hidden switch. With `labels` the fields are fixed and
 * shown by those names; without them the person names, adds and removes fields.
 */
export function LoginFieldsEditor({
  fields,
  onChange,
  labels,
  editable,
  inputs,
  onEndEditing,
  onSubmit,
}: {
  fields: readonly LoginFieldRow[];
  onChange: (update: (fields: LoginFieldRow[]) => LoginFieldRow[]) => void;
  labels?: readonly string[];
  editable: boolean;
  /** The value inputs by position, for focus and for clearing before the sheet closes. */
  inputs: RefObject<(TextInput | null)[]>;
  onEndEditing: (text: string) => void;
  onSubmit: () => void;
}) {
  const { t } = useI18n();
  const styles = useThemedStyles(createStyles);
  const change = (id: number, patch: Partial<LoginFieldInput>) =>
    onChange((current) =>
      current.map((field) => (field.id === id ? { ...field, ...patch } : field)),
    );

  return (
    <>
      {fields.map((field, index) => {
        const name = labels?.[index] ?? (field.label.trim() || t("Value"));
        const last = index === fields.length - 1;
        return (
          <View key={field.id} style={styles.group}>
            {labels ? null : (
              <View style={[styles.row, styles.separated]}>
                <TextInput
                  accessibilityLabel={t("Label")}
                  value={field.label}
                  onChangeText={(label) => change(field.id, { label })}
                  placeholder={t("Label")}
                  placeholderTextColor={styles.placeholder.color}
                  textContentType="none"
                  autoComplete="off"
                  autoCorrect={false}
                  editable={editable}
                  style={styles.input}
                />
                {fields.length > 1 ? (
                  <NativeActionButton
                    accessibilityLabel={t("Remove")}
                    icon={{ ios: "minus.circle", android: "remove-circle-outline" }}
                    prominence="quiet"
                    disabled={!editable}
                    onPress={() =>
                      onChange((current) => current.filter((item) => item.id !== field.id))
                    }
                    style={styles.remove}
                  />
                ) : null}
              </View>
            )}
            <View style={[styles.row, styles.separated]}>
              <TextInput
                ref={(node) => {
                  inputs.current[index] = node;
                }}
                accessibilityLabel={name}
                value={field.value}
                onChangeText={(value) => change(field.id, { value })}
                placeholder={name}
                placeholderTextColor={styles.placeholder.color}
                secureTextEntry={field.hidden}
                {...loginFieldTraits(field.hidden)}
                autoCorrect={false}
                autoCapitalize="none"
                returnKeyType={last ? "done" : "next"}
                submitBehavior={last ? undefined : "submit"}
                onSubmitEditing={() => (last ? onSubmit() : inputs.current[index + 1]?.focus())}
                editable={editable}
                onEndEditing={(event) => onEndEditing(event.nativeEvent.text)}
                style={styles.input}
              />
            </View>
            <View style={styles.row}>
              <Text style={styles.switchLabel}>{t("Hidden")}</Text>
              <NativeSwitch
                accessibilityLabel={t("Hidden")}
                disabled={!editable}
                value={field.hidden}
                onValueChange={(hidden) => change(field.id, { hidden })}
              />
            </View>
          </View>
        );
      })}
      {labels || fields.length >= LOGIN_FIELD_LIMIT ? null : (
        <NativeActionButton
          label={t("Add field")}
          icon={{ ios: "plus", android: "add" }}
          prominence="plain"
          fill={false}
          disabled={!editable}
          onPress={() => onChange((current) => [...current, emptyLoginField(current)])}
        />
      )}
    </>
  );
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    group: { backgroundColor: tokens.muted, borderRadius: 13, overflow: "hidden" },
    row: { flexDirection: "row", alignItems: "center", minHeight: 52, paddingHorizontal: 16 },
    separated: { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: tokens.border },
    input: { flex: 1, minWidth: 0, paddingVertical: 16, color: tokens.foreground },
    remove: { minWidth: 44, minHeight: 44, marginRight: -8 },
    switchLabel: { flex: 1, color: tokens.foreground, fontSize: 17 },
    placeholder: { color: tokens.faintForeground },
  });
}
