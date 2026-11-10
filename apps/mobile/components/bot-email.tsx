import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { BotEmailAddress, BotEmailAddresses } from "@rakazo/contracts";
import { parseBotEmailName, suggestedEmailName } from "@rakazo/contracts";
import * as Clipboard from "expo-clipboard";
import { useFocusEffect } from "expo-router";
import type { ReactElement } from "react";
import { useCallback, useEffect, useState } from "react";
import { Text } from "react-native";
import { rpc } from "../lib/api";
import { native, useMobileTokens } from "../lib/native";
import { errorText } from "../lib/user-error";
import { NativeSymbol } from "./native-symbol";
import { SettingsGroup, SettingsInputRow, SettingsRow } from "./settings-group";

export type BotEmail = {
  /** Null when this server receives no email, or until it answers. */
  address: BotEmailAddress;
  /** The domain of the signed-in owner's own email, for "Anyone at". */
  ownerDomain: string;
  setAddress: (address: string) => void;
};

/** The bot's email address and the owner's domain, read once for the screen. */
export function useBotEmail(botId: string): BotEmail {
  // Kept with the bot it belongs to, so switching bots never shows the last one's address.
  const [read, setRead] = useState<{ botId: string; email: BotEmailAddress }>({
    botId,
    email: null,
  });
  const [ownerDomain, setOwnerDomain] = useState("");
  // Read apart, so a failed profile read never hides the address, only the "Anyone at" choice.
  // Read again on focus: the address may have been claimed on another screen meanwhile.
  useFocusEffect(
    useCallback(() => {
      let current = true;
      void rpc("bots/emailAddress", { botId })
        .then((email) => {
          if (!current) return;
          // An address is the bot's for good: a read that started before a claim never undoes it.
          setRead((prior) =>
            prior.botId === botId && prior.email?.address && !email?.address
              ? prior
              : { botId, email },
          );
        })
        // Without an answer the screen offers no address; returning to it reads again.
        .catch(() => undefined);
      void rpc("me")
        .then((me) => {
          if (current) setOwnerDomain(me.email.slice(me.email.lastIndexOf("@") + 1));
        })
        .catch(() => undefined);
      return () => {
        current = false;
      };
    }, [botId]),
  );
  return {
    address: read.botId === botId ? read.email : null,
    ownerDomain,
    setAddress: (claimed) =>
      setRead((prior) =>
        prior.botId === botId && prior.email
          ? { botId, email: { ...prior.email, address: claimed } }
          : prior,
      ),
  };
}

/**
 * Settings rows for the bot's address: one that copies it, or the name field and the row that
 * claims it for good. Returned as rows so a SettingsGroup separates them.
 */
export function useBotEmailRows({
  botId,
  botName,
  email,
}: {
  botId: string;
  botName: string;
  email: BotEmail;
}): ReactElement[] {
  const { t } = useLingui();
  const tokens = useMobileTokens();
  const [name, setName] = useState(() => suggestedEmailName(botName));
  const [edited, setEdited] = useState(false);
  // The bot's real name can arrive after the screen opens; follow it until the owner types.
  useEffect(() => {
    if (!edited) setName(suggestedEmailName(botName));
  }, [botName, edited]);
  const [claiming, setClaiming] = useState(false);
  const [claimError, setClaimError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const domain = email.address?.domain;
  const address = email.address?.address ?? null;

  async function claim() {
    if (claiming || !domain) return;
    const parsed = parseBotEmailName(name);
    if (parsed.problem) {
      setClaimError(
        {
          length: t`Use 2 to 64 characters`,
          taken: t`That address isn't available`,
          characters: t`Use letters, numbers, dots, dashes or underscores`,
        }[parsed.problem],
      );
      return;
    }
    setClaiming(true);
    setClaimError(null);
    try {
      email.setAddress((await rpc("bots/claimEmailAddress", { botId, name: parsed.name })).address);
    } catch (cause) {
      setClaimError(errorText(cause, t`That address isn't available`));
    } finally {
      setClaiming(false);
    }
  }

  if (!domain) return [];
  if (address) {
    return [
      <SettingsRow
        key="address"
        accessibilityRole="button"
        accessibilityLabel={t`Copy ${address}`}
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
      />,
    ];
  }
  return [
    <SettingsInputRow
      key="name"
      accessibilityLabel={t`Email address`}
      autoCapitalize="none"
      autoCorrect={false}
      keyboardType="email-address"
      value={name}
      onChangeText={(next) => {
        setName(next);
        setEdited(true);
        setClaimError(null);
      }}
      onSubmitEditing={() => void claim()}
    />,
    <SettingsRow
      key="claim"
      accessibilityRole="button"
      tinted
      dimmed={claiming || !name}
      title={t`Claim ${ph({ address: `${name.trim().toLowerCase()}@${domain}` })}`}
      onPress={() => void claim()}
    />,
    ...(claimError
      ? [
          <Text
            key="error"
            accessibilityRole="alert"
            style={{ color: tokens.destructive, fontSize: 15, padding: 16 }}
          >
            {claimError}
          </Text>,
        ]
      : []),
  ];
}

/** The bots' addresses in the Vault, beside the logins they use; nothing until one is claimed. */
export function BotEmailAddressesGroup() {
  const { t } = useLingui();
  const [email, setEmail] = useState<BotEmailAddresses>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // Read on each visit, so an address claimed elsewhere meanwhile shows up.
  useFocusEffect(
    useCallback(() => {
      let current = true;
      void rpc("bots/emailAddresses")
        .then((next) => {
          if (current) setEmail(next);
        })
        // The list read before may be another Space's, so a failed read hides it.
        .catch(() => {
          if (current) setEmail(null);
        });
      return () => {
        current = false;
      };
    }, []),
  );
  if (!email?.addresses.length) return null;
  return (
    <SettingsGroup label={t`Bot email addresses`}>
      {email.addresses.map((row) => (
        <SettingsRow
          key={row.botId}
          accessibilityRole="button"
          accessibilityLabel={t`Copy ${ph({ address: row.address })}`}
          title={row.botName}
          detail={row.address}
          trailing={
            <NativeSymbol
              ios={copied === row.address ? "checkmark" : "doc.on.doc"}
              android={copied === row.address ? "checkmark" : "copy-outline"}
              color={native.tertiaryLabel}
              size={15}
            />
          }
          onPress={() =>
            void Clipboard.setStringAsync(row.address).then(() => {
              setCopied(row.address);
              setTimeout(() => setCopied(null), 1500);
            })
          }
        />
      ))}
    </SettingsGroup>
  );
}
