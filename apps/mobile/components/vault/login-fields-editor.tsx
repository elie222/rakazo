import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { LoginFieldInput } from "@rakazo/contracts";
import { LOGIN_FIELD_LIMIT } from "@rakazo/contracts";
import type { RefObject } from "react";
import { useEffect, useRef, useState } from "react";
import type { TextInputInstance } from "react-native";
import { StyleSheet, Text, TextInput, View } from "react-native";
import { mobileTokens } from "../../lib/appearance/appearance";
import { useThemedStyles } from "../../lib/native/native";
import { loginFieldTraits } from "../../lib/vault/secret-field-traits";
import { NativeActionButton } from "../native/native-action-button";
import { NativeSwitch } from "../native/native-switch";

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
 * The values of a website login. With `labels` the fields are fixed and shown by those names;
 * without them the person names, adds and removes fields. A Hidden switch says which values are
 * typed only into password fields. `hiddenFixed` leaves it out where the labels can't be wrong (the
 * default Username and Password) and gives each secret field an eye to check it while typing.
 */
export function LoginFieldsEditor({
  fields,
  onChange,
  labels,
  hiddenFixed = false,
  editable,
  inputs,
  onEndEditing,
  onSubmit,
}: {
  fields: readonly LoginFieldRow[];
  onChange: (update: (fields: LoginFieldRow[]) => LoginFieldRow[]) => void;
  labels?: readonly string[];
  /** Fields keep the Hidden setting they start with; only for fixed `labels`. */
  hiddenFixed?: boolean;
  editable: boolean;
  /** The value inputs by position, for focus and for clearing before the sheet closes. */
  inputs: RefObject<(TextInputInstance | null)[]>;
  onEndEditing: (text: string) => void;
  onSubmit: () => void;
}) {
  const { t } = useLingui();
  const styles = useThemedStyles(createStyles);
  // Fields shown while typing; their saved Hidden setting is unchanged.
  const [shown, setShown] = useState<ReadonlySet<number>>(new Set());
  const isShown = (field: LoginFieldRow) => shown.has(field.id);
  // A field that is emptied (a failed save clears every value) is masked again, so what is typed
  // next starts hidden.
  const previous = useRef(fields);
  useEffect(() => {
    const emptied = fields
      .filter(
        (field) =>
          field.value === "" &&
          previous.current.some((before) => before.id === field.id && before.value !== ""),
      )
      .map((field) => field.id);
    previous.current = fields;
    if (emptied.length === 0) return;
    setShown((current) => new Set([...current].filter((id) => !emptied.includes(id))));
  }, [fields]);
  const toggleShown = (id: number) =>
    setShown((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  const change = (id: number, patch: Partial<LoginFieldInput>) =>
    onChange((current) =>
      current.map((field) => (field.id === id ? { ...field, ...patch } : field)),
    );

  return (
    <>
      {fields.map((field, index) => {
        const name = labels?.[index] ?? (field.label.trim() || t`Value`);
        const last = index === fields.length - 1;
        return (
          <View key={field.id} style={styles.group}>
            {labels ? null : (
              <View style={[styles.row, styles.separated]}>
                <TextInput
                  accessibilityLabel={t`Label`}
                  value={field.label}
                  onChangeText={(label) => change(field.id, { label })}
                  placeholder={t`Label`}
                  placeholderTextColor={styles.placeholder.color}
                  textContentType="none"
                  autoComplete="off"
                  autoCorrect={false}
                  editable={editable}
                  style={styles.input}
                />
                {fields.length > 1 ? (
                  <NativeActionButton
                    accessibilityLabel={t`Remove`}
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
            <View style={[styles.row, hiddenFixed ? undefined : styles.separated]}>
              <TextInput
                ref={(node) => {
                  inputs.current[index] = node;
                }}
                accessibilityLabel={name}
                value={field.value}
                onChangeText={(value) => change(field.id, { value })}
                placeholder={name}
                placeholderTextColor={styles.placeholder.color}
                secureTextEntry={field.hidden && !isShown(field)}
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
              {hiddenFixed && field.hidden ? (
                <NativeActionButton
                  accessibilityLabel={
                    isShown(field) ? t`Hide ${ph({ field: name })}` : t`Show ${ph({ field: name })}`
                  }
                  icon={
                    isShown(field)
                      ? { ios: "eye.slash", android: "eye-off-outline" }
                      : { ios: "eye", android: "eye-outline" }
                  }
                  prominence="quiet"
                  onPress={() => toggleShown(field.id)}
                  style={styles.reveal}
                />
              ) : null}
            </View>
            {hiddenFixed ? null : (
              <View style={styles.row}>
                <Text style={styles.switchLabel}>{t`Hidden`}</Text>
                <NativeSwitch
                  accessibilityLabel={t`Hidden`}
                  accessibilityHint={name}
                  disabled={!editable}
                  value={field.hidden}
                  onValueChange={(hidden) => change(field.id, { hidden })}
                />
              </View>
            )}
          </View>
        );
      })}
      {labels || fields.length >= LOGIN_FIELD_LIMIT ? null : (
        <NativeActionButton
          label={t`Add field`}
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
    reveal: { marginRight: -4, alignSelf: "center" },
    switchLabel: { flex: 1, color: tokens.foreground, fontSize: 17 },
    placeholder: { color: tokens.faintForeground },
  });
}
