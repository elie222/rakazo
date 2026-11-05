import type { BotEmailAddress, RoutineEmailSenders } from "@rakazo/contracts";
import { BOT_EMAIL_NAME_TAKEN, BotEmailNameSchema, suggestedEmailName } from "@rakazo/contracts";
import * as Clipboard from "expo-clipboard";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { rpc } from "../lib/api";
import { useI18n } from "../lib/i18n";
import { native, useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";
import { MenuPicker } from "./menu-picker";
import { NativeSymbol } from "./native-symbol";
import { SettingsGroup, SettingsInputRow, SettingsRow } from "./settings-group";

export type BotEmail = {
  /** Null when this server receives no email, or until it answers. */
  address: BotEmailAddress;
  /** The domain of the signed-in owner's own email, for "Anyone at". */
  ownerDomain: string;
  setAddress: (address: string) => void;
};

/** The bot's email address and the owner's domain, read once for the editor. */
export function useBotEmail(botId: string): BotEmail {
  const [address, setAddress] = useState<BotEmailAddress>(null);
  const [ownerDomain, setOwnerDomain] = useState("");
  useEffect(() => {
    let current = true;
    void Promise.all([rpc("bots/emailAddress", { botId }), rpc("me")])
      .then(([email, me]) => {
        if (!current) return;
        setAddress(email);
        setOwnerDomain(me.email.slice(me.email.lastIndexOf("@") + 1));
      })
      // Without an answer the editor simply offers no email trigger.
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [botId]);
  return {
    address,
    ownerDomain,
    setAddress: (claimed) =>
      setAddress((prior) => (prior ? { ...prior, address: claimed } : prior)),
  };
}

/** The email trigger in the routine editor: the bot's address, who can start it, and removal. */
export function RoutineEmailTrigger({
  botId,
  botName,
  email,
  senders,
  onChange,
  onRemove,
}: {
  botId: string;
  botName: string;
  email: BotEmail;
  senders: RoutineEmailSenders;
  onChange: (senders: RoutineEmailSenders) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [name, setName] = useState(() => suggestedEmailName(botName));
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const domain = email.address?.domain;
  const address = email.address?.address ?? null;

  async function claim() {
    if (claiming || !domain) return;
    const parsed = BotEmailNameSchema.safeParse(name);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      setClaimError(
        issue?.code === "too_small" || issue?.code === "too_big"
          ? t("Use 2 to 64 characters")
          : issue?.message === BOT_EMAIL_NAME_TAKEN
            ? t("That address isn't available")
            : t("Use letters, numbers, dots, dashes or underscores"),
      );
      return;
    }
    setClaiming(true);
    setClaimError(null);
    try {
      email.setAddress((await rpc("bots/claimEmailAddress", { botId, name: parsed.data })).address);
    } catch (cause) {
      setClaimError(errorText(cause, t("That address isn't available")));
    } finally {
      setClaiming(false);
    }
  }

  return (
    <SettingsGroup label={t("When an email arrives")}>
      {address ? (
        <SettingsRow
          key="address"
          accessibilityRole="button"
          accessibilityLabel={t("Copy {address}", { address })}
          title={address}
          trailing={
            <NativeSymbol
              ios={copied ? "checkmark" : "doc.on.doc"}
              android={copied ? "checkmark" : "copy-outline"}
              color={native.tertiaryLabel}
              size={15}
            />
          }
          onPress={() =>
            void Clipboard.setStringAsync(address).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            })
          }
        />
      ) : domain ? (
        <SettingsInputRow
          key="name"
          accessibilityLabel={t("Email address")}
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="email-address"
          value={name}
          onChangeText={(next) => {
            setName(next);
            setClaimError(null);
          }}
          onSubmitEditing={() => void claim()}
        />
      ) : null}
      {!address && domain ? (
        <SettingsRow
          key="claim"
          accessibilityRole="button"
          tinted
          dimmed={claiming || !name}
          title={t("Claim {address}", { address: `${name.trim().toLowerCase()}@${domain}` })}
          onPress={() => void claim()}
        />
      ) : null}
      {claimError ? (
        <Text
          key="error"
          accessibilityRole="alert"
          style={{ color: tokens.destructive, fontSize: 15, padding: 16 }}
        >
          {claimError}
        </Text>
      ) : null}
      {domain && email.ownerDomain ? (
        <MenuPicker
          key="senders"
          label={t("Who can start it")}
          value={senders}
          choices={[
            { key: "owner", label: t("Only me") },
            { key: "domain", label: t("Anyone at @{domain}", { domain: email.ownerDomain }) },
          ]}
          onChange={(key) => onChange(key as RoutineEmailSenders)}
        />
      ) : null}
      <SettingsRow
        key="remove"
        accessibilityRole="button"
        destructive
        title={t("Remove email trigger")}
        onPress={onRemove}
      />
    </SettingsGroup>
  );
}
