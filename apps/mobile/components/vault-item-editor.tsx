import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { ContactFields, VaultKind, VaultPolicy, VaultRevealed } from "@rakazo/contracts";
import {
  authenticatorKey,
  commandVariableName,
  decodeLoginSecret,
  encodeLoginSecret,
  hasVaultAccess,
  LoginSecretValue,
  typedOtherSites,
  VAULT_ALSO_ON_LIMIT,
} from "@rakazo/contracts";
import { secretAnswerErrorText } from "@rakazo/i18n/vault";
import type { ReactNode } from "react";
import { useRef, useState } from "react";
import type { TextInputInstance, TextInputProps } from "react-native";
import { Modal, Platform, ScrollView, StyleSheet, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { mobileTokens } from "../lib/appearance";
import type { MobileBot } from "../lib/mobile-types";
import { useThemedStyles } from "../lib/native";
import { useSecretSheetClose } from "../lib/secret-sheet-close";
import { errorText } from "../lib/user-error";
import type { ApiAuthType, VaultBots, VaultDraft, VaultItem, VaultSave } from "../lib/vault";
import {
  draftSave,
  emptyDraft,
  itemDraft,
  typedCardBrand,
  variableName,
  variableProblem,
  vaultKindLabel,
} from "../lib/vault";
import type { LoginFieldRow } from "./login-fields-editor";
import { LoginFieldsEditor } from "./login-fields-editor";
import { MenuPicker } from "./menu-picker";
import { NativeActionButton } from "./native-action-button";
import { NativeSegmentedControl } from "./native-segmented-control";
import { NativeSymbol } from "./native-symbol";
import { SettingsRow } from "./settings-group";

type ContactKey = keyof ContactFields;

/**
 * Adds or edits a vault item of one kind, in Settings or for a bot's request in chat. Protected
 * values live only in this sheet's state and are cleared on save and before it closes. `ask` hides
 * the title and note: a request saves under the name the bot gave it.
 */
export function VaultItemEditor({
  kind,
  item,
  revealed,
  ask,
  title,
  contacts = [],
  bots,
  botsNote,
  onClose,
  onSave,
}: {
  kind: VaultKind;
  /** The saved item being edited; without one the sheet adds an item. */
  item?: VaultItem;
  /** A saved login's or card's value, revealed before editing so the form starts from all of it. */
  revealed?: VaultRevealed;
  ask?: boolean;
  /** The sheet's heading; defaults to the kind, or the item's title. */
  title?: string;
  /** Saved contacts a card can be billed to. */
  contacts?: readonly { key: string; label: string }[];
  onClose: () => void;
  /** The owner's bots in this Space; left out when the server can't limit an item to some. */
  bots?: readonly MobileBot[];
  /** Said under the bots when only some may use it, or when this Space's can't be chosen. */
  botsNote?: string;
  onSave: (save: VaultSave, policy?: VaultPolicy, access?: VaultBots) => Promise<void>;
}) {
  const { t } = useLingui();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const inputs = useRef<(TextInputInstance | null)[]>([]);
  const [draft, setDraft] = useState<VaultDraft>(() => {
    const fields: LoginFieldRow[] = [
      { id: 0, label: t`Username`, value: item?.preview?.username ?? "", hidden: false },
      { id: 1, label: t`Password`, value: "", hidden: true },
    ];
    if (!item) return emptyDraft(fields);
    const draft = itemDraft(item, fields, revealed);
    // A billing contact removed since the card was saved reads as none, so a save drops it.
    return contacts.some((contact) => contact.key === draft.billing)
      ? draft
      : { ...draft, billing: "" };
  });
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const savedPolicy = item?.policy ?? "allow";
  const [policy, setPolicy] = useState<VaultPolicy>(savedPolicy);
  // Only a login asks first.
  const policies = (["allow", "ask", "off"] as const).filter(
    (option) =>
      !ask &&
      hasVaultAccess(kind) &&
      (option !== "ask" || kind === "login" || savedPolicy === "ask"),
  );
  const policyLabels: Record<VaultPolicy, string> = {
    allow: t`Allow`,
    ask: t`Ask first`,
    off: t`Block`,
  };
  const savedAccess = { allBots: item?.allBots ?? true, botIds: item?.botIds ?? [] };
  const [access, setAccess] = useState<VaultBots>(savedAccess);
  const accessChanged =
    access.allBots !== savedAccess.allBots || access.botIds.join() !== savedAccess.botIds.join();
  // As on the web, a Space without bots has nothing to choose from.
  const choosing = bots?.length && !ask && policy !== "off";
  const noted = botsNote && !ask && policy !== "off" && (!bots || !access.allBots);
  // Chosen bots this list doesn't show, such as archived ones, stay chosen.
  const toggleBot = (id: string) =>
    setAccess((prev) => ({
      ...prev,
      botIds: prev.botIds.includes(id)
        ? prev.botIds.filter((botId) => botId !== id)
        : [...prev.botIds, id],
    }));
  const savedAlsoOn = item?.alsoOn?.join(", ") ?? "";
  const [alsoOn, setAlsoOn] = useState(savedAlsoOn);
  const savedOtp = revealed && "fields" in revealed ? (revealed.otp ?? "") : "";
  const [otp, setOtp] = useState(savedOtp);
  const [otpShown, setOtpShown] = useState(Boolean(otp));
  const [alsoOnShown, setAlsoOnShown] = useState(Boolean(savedAlsoOn));
  const update = (change: Partial<VaultDraft>) => setDraft((prev) => ({ ...prev, ...change }));
  const clear = () => {
    setOtp("");
    setDraft((prev) => ({
      ...prev,
      value: "",
      number: "",
      cvc: "",
      fields: prev.fields.map((field) => ({ ...field, value: field.hidden ? "" : field.value })),
    }));
  };
  const { close, closing, endEditing } = useSecretSheetClose(inputs, clear, onClose);
  const draftChange = draftSave(kind, draft, item);
  const login = kind === "login" && !ask;
  // Checked before Save clears what was typed, so a typo is fixed without retyping.
  const keyUnreadable = login && otp.trim() !== "" && !authenticatorKey(otp);
  const typedSites = typedOtherSites(alsoOn);
  const otherSites = Array.isArray(typedSites) ? typedSites : undefined;
  // A key left as shown is not sent, so the saved one stays: the copy shown may be older than it.
  // A chat card's answer sends none either. The whole value as it is saved, key included, is
  // checked here so encoding never throws in render.
  const loginValue =
    login && draftChange?.value
      ? LoginSecretValue.safeParse({
          ...decodeLoginSecret(draftChange.value),
          ...(otp === savedOtp ? {} : { otp }),
        })
      : undefined;
  const save: VaultSave | undefined =
    !loginValue || !draftChange
      ? draftChange
      : loginValue.success && otherSites
        ? { ...draftChange, value: encodeLoginSecret(loginValue.data) }
        : undefined;
  const editable = !submitting && !closing;
  // A save in flight keeps the sheet open, so its failure is still shown here.
  const cancel = () => {
    if (!submitting) close();
  };

  async function submit() {
    if (submitting || !save) return;
    const typedKey = otp;
    clear();
    setSubmitting(true);
    setError(null);
    try {
      await onSave(
        login && otherSites && alsoOn !== savedAlsoOn ? { ...save, alsoOn: otherSites } : save,
        policy !== savedPolicy ? policy : undefined,
        bots && accessChanged ? access : undefined,
      );
      close();
    } catch (err) {
      // Kept, so saving again after fixing the password doesn't remove the key.
      setOtp(typedKey);
      setError(
        ask
          ? secretAnswerErrorText(err, t`Could not send answer`)
          : errorText(err, t`Could not save`),
      );
    } finally {
      setSubmitting(false);
    }
  }

  const field = (
    label: string,
    value: string,
    onChange: (text: string) => void,
    props: TextInputProps & { slot?: number } = {},
  ) => {
    const { slot, ...input } = props;
    return (
      <View key={label} style={styles.row}>
        <Text style={styles.label}>{label}</Text>
        <TextInput
          ref={
            slot === undefined
              ? undefined
              : (node) => {
                  inputs.current[slot] = node;
                }
          }
          accessibilityLabel={label}
          value={value}
          onChangeText={onChange}
          placeholderTextColor={styles.placeholder.color}
          autoCorrect={false}
          editable={editable}
          onEndEditing={
            slot === undefined ? undefined : (event) => endEditing(event.nativeEvent.text)
          }
          {...input}
          style={styles.input}
        />
      </View>
    );
  };

  const contactField = (key: ContactKey, label: string, props: TextInputProps = {}) =>
    field(
      label,
      draft.contact[key],
      (text) => update({ contact: { ...draft.contact, [key]: text } }),
      {
        autoCapitalize: "words",
        ...props,
      },
    );

  const pair = (left: ReactNode, right: ReactNode) => (
    <View style={styles.pair}>
      <View style={styles.half}>{left}</View>
      <View style={[styles.half, styles.pairEnd]}>{right}</View>
    </View>
  );

  const apiTypes: { key: ApiAuthType; label: string }[] = [
    { key: "bearer", label: t`Bearer token` },
    { key: "header", label: t`Custom header` },
    { key: "basic", label: t`Basic auth` },
  ];
  const brand = typedCardBrand(draft.number);
  const problem = kind === "variable" && !item ? variableProblem(draft) : undefined;
  const heading = title ?? item?.title ?? vaultKindLabel(kind);

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={cancel}>
      <View
        accessibilityViewIsModal
        style={[
          styles.sheet,
          // Page sheets clear the notch on iOS; Android modals are full-screen.
          {
            paddingTop: Platform.OS === "ios" ? 12 : insets.top + 12,
            paddingBottom: insets.bottom,
          },
        ]}
      >
        <View style={styles.header}>
          <NativeActionButton
            disabled={submitting}
            label={t`Cancel`}
            onPress={cancel}
            prominence="plain"
          />
          <NativeActionButton
            disabled={!save}
            busy={submitting}
            fill={false}
            label={t`Save`}
            onPress={() => void submit()}
            prominence={save ? "primary" : "plain"}
          />
        </View>
        <ScrollView
          contentContainerStyle={styles.content}
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
        >
          <Text accessibilityRole="header" style={styles.title} numberOfLines={2}>
            {heading}
          </Text>

          {kind === "login" ? (
            <>
              {item ? null : (
                <View style={styles.group}>
                  {field(t`Site`, draft.origin, (origin) => update({ origin }), {
                    placeholder: "https://example.com",
                    keyboardType: "url",
                    autoCapitalize: "none",
                    textContentType: "URL",
                  })}
                </View>
              )}
              <LoginFieldsEditor
                fields={draft.fields as LoginFieldRow[]}
                onChange={(change) =>
                  setDraft((prev) => ({ ...prev, fields: change(prev.fields as LoginFieldRow[]) }))
                }
                editable={editable}
                inputs={inputs}
                onEndEditing={endEditing}
                onSubmit={() => void submit()}
              />
              {ask || !(otpShown || alsoOnShown) ? null : (
                <View style={styles.group}>
                  {otpShown
                    ? field(t`Authenticator key`, otp, setOtp, {
                        // After the login's fields, so closing the sheet empties it with them.
                        slot: draft.fields.length,
                        secureTextEntry: true,
                        autoCapitalize: "none",
                        autoComplete: "off",
                        textContentType: "none",
                      })
                    : null}
                  {otpShown && alsoOnShown ? <View style={styles.separator} /> : null}
                  {alsoOnShown
                    ? field(t`Also on`, alsoOn, setAlsoOn, {
                        placeholder: "https://login.example.com",
                        keyboardType: "url",
                        autoCapitalize: "none",
                      })
                    : null}
                </View>
              )}
              {keyUnreadable ? (
                <Text style={styles.error}>{t`This authenticator key can't be read.`}</Text>
              ) : null}
              {login && typedSites === "not_https" ? (
                <Text style={styles.error}>{t`Enter each site as an HTTPS address.`}</Text>
              ) : login && typedSites === "too_many" ? (
                <Text style={styles.error}>
                  {t`Up to ${ph({ limit: VAULT_ALSO_ON_LIMIT })} sites.`}
                </Text>
              ) : null}
              {ask || otpShown ? null : (
                <NativeActionButton
                  label={t`Add an authenticator key`}
                  onPress={() => setOtpShown(true)}
                  prominence="plain"
                />
              )}
              {ask || alsoOnShown ? null : (
                <NativeActionButton
                  label={t`Add other sites`}
                  onPress={() => setAlsoOnShown(true)}
                  prominence="plain"
                />
              )}
            </>
          ) : null}

          {kind === "card" ? (
            <View style={styles.group}>
              {field(t`Card number`, draft.number, (number) => update({ number }), {
                slot: 0,
                placeholder: item?.preview?.card ? `•••• ${item.preview.card.last4}` : undefined,
                keyboardType: "number-pad",
                textContentType: "creditCardNumber",
                autoComplete: "cc-number",
              })}
              {brand ? <Text style={styles.brand}>{brand}</Text> : null}
              <View style={styles.separator} />
              {pair(
                field(t`Expiry`, draft.expiry, (expiry) => update({ expiry }), {
                  placeholder: "MM/YY",
                  keyboardType: "numbers-and-punctuation",
                  autoComplete: "cc-exp",
                }),
                field(t`Security code`, draft.cvc, (cvc) => update({ cvc }), {
                  slot: 1,
                  secureTextEntry: true,
                  keyboardType: "number-pad",
                  autoComplete: "cc-csc",
                  textContentType: "none",
                }),
              )}
              <View style={styles.separator} />
              {field(t`Name on card`, draft.cardName, (cardName) => update({ cardName }), {
                autoCapitalize: "words",
                autoComplete: "cc-name",
                textContentType: "name",
              })}
              {contacts.length ? (
                <>
                  <View style={styles.separator} />
                  <MenuPicker
                    label={t`Billing address`}
                    choices={[{ key: "", label: t`None` }, ...contacts]}
                    value={draft.billing}
                    onChange={(billing) => update({ billing })}
                  />
                </>
              ) : null}
            </View>
          ) : null}

          {kind === "contact" ? (
            <View style={styles.group}>
              {contactField("name", t`Full name`, {
                textContentType: "name",
                autoComplete: "name",
              })}
              <View style={styles.separator} />
              {contactField("line1", t`Address`, {
                textContentType: "streetAddressLine1",
                autoComplete: "address-line1",
              })}
              <View style={styles.separator} />
              {contactField("line2", t`Address line 2`, {
                textContentType: "streetAddressLine2",
                autoComplete: "address-line2",
              })}
              <View style={styles.separator} />
              {pair(
                contactField("city", t`City`, { textContentType: "addressCity" }),
                contactField("region", t`State or region`, { textContentType: "addressState" }),
              )}
              <View style={styles.separator} />
              {pair(
                contactField("postalCode", t`ZIP or postal code`, {
                  textContentType: "postalCode",
                  autoComplete: "postal-code",
                  autoCapitalize: "characters",
                }),
                contactField("country", t`Country`, { textContentType: "countryName" }),
              )}
              <View style={styles.separator} />
              {contactField("phone", t`Phone`, {
                keyboardType: "phone-pad",
                textContentType: "telephoneNumber",
                autoComplete: "tel",
              })}
              <View style={styles.separator} />
              {contactField("email", t`Email`, {
                keyboardType: "email-address",
                textContentType: "emailAddress",
                autoComplete: "email",
                autoCapitalize: "none",
              })}
            </View>
          ) : null}

          {kind === "api_key" ? (
            <View style={styles.group}>
              {item ? null : (
                <>
                  {field(t`Site`, draft.origin, (origin) => update({ origin }), {
                    placeholder: "https://api.example.com",
                    keyboardType: "url",
                    autoCapitalize: "none",
                    textContentType: "URL",
                  })}
                  <View style={styles.separator} />
                  <MenuPicker
                    label={t`Type`}
                    choices={apiTypes}
                    value={draft.apiAuth}
                    onChange={(key) => update({ apiAuth: key as ApiAuthType })}
                  />
                  {draft.apiAuth === "header" ? (
                    <>
                      <View style={styles.separator} />
                      {field(
                        t`Header name`,
                        draft.headerName,
                        (headerName) => update({ headerName }),
                        {
                          placeholder: "X-Api-Key",
                          autoCapitalize: "none",
                        },
                      )}
                    </>
                  ) : null}
                  {draft.apiAuth === "basic" ? (
                    <>
                      <View style={styles.separator} />
                      {field(
                        t`Username`,
                        draft.basicUsername,
                        (basicUsername) => update({ basicUsername }),
                        {
                          autoCapitalize: "none",
                        },
                      )}
                    </>
                  ) : null}
                  <View style={styles.separator} />
                </>
              )}
              {secretValueField()}
            </View>
          ) : null}

          {kind === "variable" ? (
            <View style={styles.group}>
              {item
                ? null
                : field(
                    t`Name`,
                    draft.variable,
                    (variable) => update({ variable: variable.toUpperCase() }),
                    {
                      placeholder: "DEPLOY_TOKEN",
                      autoCapitalize: "characters",
                    },
                  )}
              {item ? null : <View style={styles.separator} />}
              {secretValueField()}
            </View>
          ) : null}
          {problem ? (
            <Text style={styles.error}>
              {problem === "reserved"
                ? t`${ph({ variable: `$${commandVariableName(variableName(draft))}` })} is reserved. Choose another name.`
                : t`Use letters, numbers and _, starting with a letter.`}
            </Text>
          ) : null}

          {ask ? null : (
            <View style={styles.group}>
              {field(
                kind === "contact" ? t`Label` : t`Title`,
                draft.title,
                (text) => update({ title: text }),
                {
                  placeholder: kind === "contact" ? t`Home` : item?.title,
                  autoCapitalize: "sentences",
                },
              )}
              <View style={styles.separator} />
              {field(t`When to use`, draft.note, (note) => update({ note }), {
                autoCapitalize: "sentences",
              })}
            </View>
          )}
          {policies.length || choosing || noted ? (
            <View style={styles.group}>
              {policies.length ? (
                <View style={styles.row}>
                  <Text style={styles.label}>{t`Bots`}</Text>
                  <NativeSegmentedControl
                    accessibilityLabel={t`Bots`}
                    disabled={!editable}
                    value={policy}
                    onChange={setPolicy}
                    options={policies.map((option) => ({
                      value: option,
                      label: policyLabels[option],
                    }))}
                  />
                </View>
              ) : null}
              {choosing ? (
                <View style={styles.row}>
                  {policies.length ? null : <Text style={styles.label}>{t`Bots`}</Text>}
                  <NativeSegmentedControl
                    accessibilityLabel={t`Bots`}
                    disabled={!editable}
                    value={access.allBots ? "all" : "chosen"}
                    onChange={(value) =>
                      setAccess((prev) => ({ ...prev, allBots: value === "all" }))
                    }
                    options={[
                      { value: "all", label: t`All bots` },
                      { value: "chosen", label: t`Chosen bots` },
                    ]}
                  />
                </View>
              ) : null}
              {choosing && !access.allBots
                ? bots.map((bot) => (
                    <SettingsRow
                      key={bot.id}
                      title={bot.name}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: access.botIds.includes(bot.id) }}
                      disabled={!editable}
                      onPress={() => toggleBot(bot.id)}
                      trailing={
                        access.botIds.includes(bot.id) ? (
                          <NativeSymbol ios="checkmark" android="checkmark" size={16} />
                        ) : null
                      }
                    />
                  ))
                : null}
              {noted ? <Text style={styles.label}>{botsNote}</Text> : null}
            </View>
          ) : null}
          {error ? (
            <Text accessibilityRole="alert" style={styles.error}>
              {error}
            </Text>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );

  function secretValueField() {
    return field(t`Value`, draft.value, (value) => update({ value }), {
      slot: 0,
      secureTextEntry: true,
      autoCapitalize: "none",
      autoComplete: "off",
      textContentType: "none",
      placeholder: item ? "••••••••" : undefined,
      returnKeyType: "done",
      onSubmitEditing: () => void submit(),
    });
  }
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    sheet: { flex: 1, backgroundColor: tokens.background },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 20,
      paddingBottom: 12,
    },
    content: { paddingHorizontal: 20, paddingBottom: 40, gap: 16 },
    title: { color: tokens.foreground, fontSize: 20, fontWeight: "600" },
    group: { backgroundColor: tokens.muted, borderRadius: 13, overflow: "hidden" },
    row: { paddingHorizontal: 16, paddingTop: 10, paddingBottom: 8, gap: 2 },
    label: { color: tokens.mutedForeground, fontSize: 13 },
    input: { color: tokens.foreground, fontSize: 17, paddingVertical: 4, minHeight: 28 },
    brand: {
      position: "absolute",
      right: 16,
      top: 34,
      color: tokens.mutedForeground,
      fontSize: 13,
    },
    separator: {
      height: StyleSheet.hairlineWidth,
      backgroundColor: tokens.border,
      marginStart: 16,
    },
    pair: { flexDirection: "row" },
    half: { flex: 1 },
    pairEnd: { borderStartWidth: StyleSheet.hairlineWidth, borderColor: tokens.border },
    placeholder: { color: tokens.faintForeground },
    error: { color: tokens.destructive, fontSize: 13 },
  });
}
