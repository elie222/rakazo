import { runWithIdentityConfirmation } from "@rakazo/contracts";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Platform } from "react-native";
import { confirmIdentity, fetchAccountSecurity, requestIdentityCode } from "../lib/api";
import { useI18n } from "../lib/i18n";
import type { IdentityMethod } from "../lib/identity-confirmation";
import { confirmIdentityOnDevice, NEW_CODE } from "../lib/identity-confirmation";
import { continueWithSso } from "../lib/sso";
import { errorText } from "../lib/user-error";
import { TextFieldDialog } from "./name-dialog";

type Entry = string | typeof NEW_CODE | null;

type Field = {
  kind: "password" | "code";
  error: string | null;
  resolve: (value: Entry) => void;
};

/**
 * `withIdentityConfirmation(action)` runs an action that reveals sensitive data. When the server
 * answers IDENTITY_CONFIRMATION_REQUIRED, it confirms it's the signed-in person and retries
 * once. iOS uses system prompts; render `identityDialog` for the Android field.
 */
export function useIdentityConfirmation() {
  const { t } = useI18n();
  const [field, setField] = useState<Field | null>(null);
  const [value, setValue] = useState("");
  const pending = useRef<Field | null>(null);
  const title = t("Confirm it's you");

  const ask = useCallback(
    (kind: Field["kind"], error: string | null) =>
      new Promise<Entry>((resolve) => {
        if (Platform.OS === "ios") {
          Alert.prompt(
            title,
            error ?? undefined,
            [
              { text: t("Cancel"), style: "cancel", onPress: () => resolve(null) },
              ...(kind === "code"
                ? [{ text: t("Email me a code"), onPress: () => resolve(NEW_CODE) }]
                : []),
              { text: t("Continue"), onPress: (entered?: string) => resolve(entered ?? null) },
            ],
            kind === "password" ? "secure-text" : "plain-text",
            "",
            kind === "code" ? "number-pad" : undefined,
          );
          return;
        }
        pending.current?.resolve(null);
        const next = { kind, error, resolve };
        pending.current = next;
        setValue("");
        setField(next);
      }),
    [t, title],
  );

  const choose = useCallback(
    (methods: IdentityMethod[]) =>
      new Promise<IdentityMethod | null>((resolve) => {
        Alert.alert(
          title,
          undefined,
          [
            ...methods.map((method) => ({
              text: method === "sso" ? t("Sign in again") : t("Email me a code"),
              onPress: () => resolve(method),
            })),
            { text: t("Cancel"), style: "cancel" as const, onPress: () => resolve(null) },
          ],
          { cancelable: true, onDismiss: () => resolve(null) },
        );
      }),
    [t, title],
  );

  const withIdentityConfirmation = useCallback(
    <T,>(action: () => Promise<T>) =>
      runWithIdentityConfirmation(action, () =>
        confirmIdentityOnDevice({
          fetchAccountSecurity,
          confirmIdentity,
          requestIdentityCode,
          reauthenticate: () => continueWithSso("reauthenticate"),
          choose,
          ask,
          errorText: (error) => errorText(error, t("Could not continue")),
        }),
      ),
    [ask, choose, t],
  );

  const settle = useCallback((entered: Entry) => {
    pending.current?.resolve(entered);
    pending.current = null;
    setField(null);
  }, []);
  useEffect(() => () => pending.current?.resolve(null), []);

  return {
    withIdentityConfirmation,
    identityDialog: field ? (
      <TextFieldDialog
        title={title}
        label={field.kind === "password" ? t("Password") : t("Code")}
        submitLabel={t("Continue")}
        value={value}
        error={field.error}
        saving={false}
        input={
          field.kind === "password"
            ? {
                autoCapitalize: "none",
                autoComplete: "current-password",
                secureTextEntry: true,
                textContentType: "password",
              }
            : {
                autoComplete: "one-time-code",
                keyboardType: "number-pad",
                textContentType: "oneTimeCode",
              }
        }
        extraAction={
          field.kind === "code"
            ? { label: t("Email me a code"), onPress: () => settle(NEW_CODE) }
            : undefined
        }
        onChange={setValue}
        onSubmit={settle}
        onClose={() => settle(null)}
      />
    ) : null,
  };
}
