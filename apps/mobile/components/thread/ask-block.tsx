import type { LoginFieldInput } from "@rakazo/contracts";
import { normalizeOneTimeCode, vaultKind } from "@rakazo/contracts";
import { isSecretAskBlock } from "@rakazo/core";
import { fontWeight, typeScale } from "@rakazo/ui-tokens";
import { useRef, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import type { MobileMessage } from "../../lib/api";
import { plainAskTitle } from "../../lib/ask-title";
import { useI18n } from "../../lib/i18n";
import { useMobileTokens } from "../../lib/native";
import { secretDestinationLabel, siteHost } from "../../lib/secret-destination";
import { secretFieldTraits } from "../../lib/secret-field-traits";
import { errorText } from "../../lib/user-error";
import { vaultKindSymbol } from "../../lib/vault";
import { NativeActionButton } from "../native-action-button";
import { NativeSymbol } from "../native-symbol";
import { SecretAskSheet } from "../secret-ask-sheet";
import { VaultItemEditor } from "../vault-item-editor";
import type { MessageActionProps } from "./message-bubble";

export function AskBlock({
  ask,
  canAnswer,
  canDismiss,
  onAnswer,
  onDismiss,
  actionProps,
}: {
  ask: Extract<MobileMessage["blocks"][number], { kind: "ask" }>;
  canAnswer: boolean;
  canDismiss: boolean;
  onAnswer: (
    answer: string,
    fields?: readonly LoginFieldInput[],
    remember?: false,
  ) => Promise<void>;
  /** Turns down a secret request without a value. */
  onDismiss: () => Promise<void>;
  actionProps: MessageActionProps;
}) {
  const tokens = useMobileTokens();
  const { t } = useI18n();
  const [answer, setAnswer] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const sheetSession = useRef(0);
  const session = sheetSession.current;
  const [saved, setSaved] = useState(false);
  const [sentOnce, setSentOnce] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const answered = saved || dismissed || ask.status === "answered";
  const secretInput = isSecretAskBlock(ask);
  const loginInput = secretInput && ask.credential?.auth.type === "login";
  const itemType = secretInput ? ask.credential?.auth.type : undefined;
  // A login, card or contact is filled in a sheet; the card itself is one compact row.
  const sheetInput = itemType === "login" || itemType === "card" || itemType === "contact";
  // A login, credential or code is for the run's user, so only they can fill one in; others see
  // the card without fields or buttons.
  const ownerOnly = secretInput && Boolean(ask.credential || ask.oneTimeCode) && !canDismiss;
  const destination = ask.credential
    ? secretDestinationLabel(ask.credential)
    : ask.oneTimeCode &&
      t("Only enter a code {host} sent you.", { host: siteHost(ask.oneTimeCode.origin) });
  const incomplete = ask.oneTimeCode
    ? !normalizeOneTimeCode(answer)
    : secretInput
      ? answer.length === 0
      : !answer.trim();
  const secretLabel =
    ask.purpose === "password"
      ? t("Password")
      : ask.purpose === "api_key"
        ? t("API key")
        : t("Code");
  const submitLabel = ask.oneTimeCode ? t("Continue") : secretInput ? t("Save") : t("Send answer");

  async function dismiss() {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    setAnswer("");
    try {
      await onDismiss();
      setDismissed(true);
    } catch {
      setError(t("Could not send answer"));
    } finally {
      setSubmitting(false);
    }
  }

  async function submit() {
    if (submitting) return;
    if (incomplete) return;
    const submitValue = secretInput ? answer : answer.trim();
    setSubmitting(true);
    setError(null);
    if (secretInput) setAnswer("");
    try {
      await onAnswer(submitValue);
      if (secretInput) setSaved(true);
    } catch (cause) {
      setError(
        secretInput ? t("Could not send answer") : errorText(cause, t("Could not send answer")),
      );
    } finally {
      setSubmitting(false);
    }
  }

  const answeredLabel = t(
    dismissed || ask.dismissed
      ? "Dismissed"
      : sentOnce || ask.remembered === false || ask.oneTimeCode
        ? "Sent"
        : "Saved",
  );

  if (sheetInput && itemType && ask.credential) {
    const symbol = vaultKindSymbol(vaultKind(itemType));
    const title = plainAskTitle(ask.text);
    const openSheet = () => {
      sheetSession.current += 1;
      setSheetOpen(true);
    };
    const closeSheet = () => {
      if (session === sheetSession.current) setSheetOpen(false);
    };
    return (
      <View style={[askRowStyles.card, { backgroundColor: tokens.card }]}>
        <View style={askRowStyles.row}>
          <View style={[askRowStyles.tile, { backgroundColor: tokens.muted }]}>
            <NativeSymbol ios={symbol.ios} android={symbol.android as never} size={17} />
          </View>
          <View style={askRowStyles.text}>
            <Text
              {...actionProps}
              numberOfLines={2}
              style={{ color: tokens.foreground, ...typeScale.cardTitle }}
            >
              {title}
            </Text>
            {destination ? (
              <Text
                numberOfLines={1}
                style={{ color: tokens.mutedForeground, ...typeScale.secondary }}
              >
                {destination}
              </Text>
            ) : null}
          </View>
          {answered ? (
            <View style={askRowStyles.done}>
              {dismissed || ask.dismissed ? null : (
                <NativeSymbol
                  ios="checkmark"
                  android="checkmark"
                  size={14}
                  color={tokens.mutedForeground}
                />
              )}
              <Text
                style={{
                  color: tokens.mutedForeground,
                  ...typeScale.secondary,
                  fontWeight: fontWeight.medium,
                }}
              >
                {answeredLabel}
              </Text>
            </View>
          ) : canAnswer && !ownerOnly ? (
            <NativeActionButton
              label={t("Add")}
              disabled={submitting}
              fill={false}
              prominence="secondary"
              size="compact"
              onPress={openSheet}
            />
          ) : null}
        </View>
        {!answered && canAnswer && !ownerOnly && canDismiss ? (
          <View style={askInputStyles.buttons}>
            <NativeActionButton
              label={t("Dismiss")}
              disabled={submitting}
              fill={false}
              prominence="plain"
              size="compact"
              onPress={() => void dismiss()}
            />
          </View>
        ) : null}
        {!answered && !canAnswer ? (
          <Text style={{ color: tokens.mutedForeground, ...typeScale.caption }}>
            {t("Waiting for this bot’s response.")}
          </Text>
        ) : null}
        {error ? (
          <Text style={{ color: tokens.destructive, ...typeScale.caption }}>{error}</Text>
        ) : null}
        {sheetOpen && loginInput ? (
          <SecretAskSheet
            title={title}
            destination={secretDestinationLabel(ask.credential)}
            replacedSite={ask.replaces?.origin}
            // Once any save is accepted, or the viewer is no longer the run's user, the open sheet
            // clears its own fields, then closes itself.
            pending={canAnswer && !answered && !ownerOnly}
            onClose={closeSheet}
            loginFields={ask.loginFields}
            onSave={async (fields, remember) => {
              if (remember) await onAnswer("", fields);
              else await onAnswer("", fields, false);
              setSentOnce(!remember);
              setSaved(true);
              closeSheet();
            }}
          />
        ) : null}
        {sheetOpen && (itemType === "card" || itemType === "contact") && !answered ? (
          <VaultItemEditor
            kind={itemType}
            ask
            title={title}
            onClose={closeSheet}
            onSave={async ({ value }) => {
              if (value === undefined) throw new Error("No value");
              await onAnswer(value);
              setSaved(true);
            }}
          />
        ) : null}
      </View>
    );
  }

  return (
    <View
      style={{
        width: secretInput ? "100%" : "90%",
        borderRadius: 18,
        backgroundColor: tokens.card,
        paddingHorizontal: 16,
        paddingVertical: 14,
        gap: 10,
      }}
    >
      <Text
        {...actionProps}
        numberOfLines={secretInput ? 2 : undefined}
        style={{ color: tokens.foreground, ...typeScale.cardTitle }}
      >
        {plainAskTitle(ask.text)}
      </Text>
      {secretInput && destination ? (
        <Text style={{ color: tokens.mutedForeground, ...typeScale.secondary }}>{destination}</Text>
      ) : null}
      {secretInput && ask.sharedBrowser && !ownerOnly && !answered ? (
        <Text style={{ color: tokens.mutedForeground, ...typeScale.secondary }}>
          {t("The bot's browser stays signed in for everyone in this space")}
        </Text>
      ) : null}
      {secretInput && ask.replaces && !ownerOnly && !answered ? (
        <Text style={{ color: tokens.mutedForeground, ...typeScale.secondary }}>
          {t("Replaces the login saved for {site}", { site: ask.replaces.origin })}
        </Text>
      ) : null}
      {ask.detail && (!secretInput || ask.oneTimeCode) ? (
        <Text style={{ color: tokens.mutedForeground, ...typeScale.secondary }}>{ask.detail}</Text>
      ) : null}
      {answered ? (
        <Text
          style={{
            // Dismissed reads like a declined approval, not a success.
            color: dismissed || ask.dismissed ? tokens.mutedForeground : tokens.success,
            ...typeScale.secondary,
            fontWeight: fontWeight.medium,
            ...(secretInput ? { marginTop: 12 } : null),
          }}
        >
          {secretInput
            ? answeredLabel
            : t("Answered: {answer}", { answer: ask.answer ?? t("Done") })}
        </Text>
      ) : canAnswer && ownerOnly ? null : canAnswer ? (
        <>
          <TextInput
            accessibilityLabel={secretInput ? secretLabel : t("Type your answer")}
            value={answer}
            onChangeText={setAnswer}
            placeholder={secretInput ? secretLabel : t("Type your answer")}
            placeholderTextColor={tokens.faintForeground}
            secureTextEntry={secretInput}
            autoComplete="off"
            {...(secretInput ? secretFieldTraits(ask.purpose, ask.credential) : {})}
            autoCorrect={secretInput ? false : undefined}
            autoCapitalize={secretInput ? "none" : "sentences"}
            editable={!submitting}
            onSubmitEditing={() => void submit()}
            style={[
              askInputStyles.field,
              secretInput ? { alignSelf: "stretch" } : undefined,
              { borderColor: tokens.border, color: tokens.foreground },
            ]}
          />
          <View style={askInputStyles.buttons}>
            <NativeActionButton
              label={submitLabel}
              disabled={incomplete}
              busy={submitting}
              fill={secretInput}
              style={secretInput ? askInputStyles.button : undefined}
              onPress={() => void submit()}
            />
            {secretInput && canDismiss ? (
              <NativeActionButton
                label={t("Dismiss")}
                disabled={submitting}
                fill={secretInput}
                style={secretInput ? askInputStyles.button : undefined}
                prominence="secondary"
                onPress={() => void dismiss()}
              />
            ) : null}
          </View>
        </>
      ) : (
        <Text style={{ color: tokens.mutedForeground, ...typeScale.caption }}>
          {t("Waiting for this bot’s response.")}
        </Text>
      )}
      {error ? (
        <Text style={{ color: tokens.destructive, ...typeScale.caption }}>{error}</Text>
      ) : null}
    </View>
  );
}

const askRowStyles = StyleSheet.create({
  card: { width: "100%", borderRadius: 18, paddingHorizontal: 14, paddingVertical: 12, gap: 8 },
  row: { flexDirection: "row", alignItems: "center", gap: 12 },
  tile: { width: 34, height: 34, borderRadius: 9, alignItems: "center", justifyContent: "center" },
  text: { flex: 1, gap: 2 },
  done: { flexDirection: "row", alignItems: "center", gap: 4 },
});

const askInputStyles = StyleSheet.create({
  field: {
    minHeight: 42,
    borderRadius: 12,
    borderWidth: 1,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  button: {
    flex: 1,
    minWidth: 100,
  },
  // Wraps at large text sizes so neither button is pushed off the card.
  buttons: {
    flexDirection: "row",
    flexWrap: "wrap",
    justifyContent: "flex-start",
    alignItems: "center",
    gap: 6,
  },
});
