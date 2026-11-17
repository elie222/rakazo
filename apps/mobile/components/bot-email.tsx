import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import { useTimeout } from "@rakazo/chat-ui/hooks";
import type { BotEmailAddress } from "@rakazo/contracts";
import { parseBotEmailName, suggestedEmailName } from "@rakazo/contracts";
import { writeSaved } from "@rakazo/core/query";
import * as Clipboard from "expo-clipboard";
import type { ReactElement } from "react";
import { useEffect, useState } from "react";
import { Text } from "react-native";
import { native, useMobileTokens } from "../lib/native";
import { accountRpcQuery, queryClient, rpcQuery, useSave } from "../lib/query";
import { useScreenQuery } from "../lib/screen-query";
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
  // Read apart, so a failed profile read never hides the address, only the "Anyone at" choice.
  // Read again on focus: the address may have been claimed on another screen meanwhile. Without
  // an answer the screen offers no address; returning to it reads again.
  const read = useScreenQuery(rpcQuery("bots/emailAddress", { botId }), { onForeground: false });
  const me = useScreenQuery(accountRpcQuery("me"), { onForeground: false }).data;
  // An address is the bot's for good: a read that started before a claim never undoes it.
  const [claimed, setClaimed] = useState<{ botId: string; address: string } | null>(null);
  const email = read.data ?? null;
  return {
    address:
      email && claimed?.botId === botId && !email.address
        ? { ...email, address: claimed.address }
        : email,
    ownerDomain: me ? me.email.slice(me.email.lastIndexOf("@") + 1) : "",
    setAddress: (address) => setClaimed({ botId, address }),
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
  // A name refused before it is sent, or the server's reason for refusing it.
  const [problem, setProblem] = useState<string | null>(null);
  const claiming = useSave({
    save: async (parsedName: string, send) => {
      const claimed = await send("bots/claimEmailAddress", { botId, name: parsedName });
      // Kept in the saved read too, so returning to the screen never offers the claim again.
      const read = rpcQuery("bots/emailAddress", { botId }).queryKey;
      if (queryClient.getQueryData(read)) {
        await writeSaved(queryClient, read, (prior) =>
          prior ? { ...prior, address: claimed.address } : null,
        );
      }
      return claimed;
    },
    onSaved: (claimed) => email.setAddress(claimed.address),
  });
  const claimError =
    problem ?? (claiming.error ? errorText(claiming.error, t`That address isn't available`) : null);
  const [copied, setCopied] = useState(false);
  useTimeout(() => setCopied(false), copied ? 1500 : null);
  const domain = email.address?.domain;
  const address = email.address?.address ?? null;

  function claim() {
    if (claiming.pending || !domain) return;
    const parsed = parseBotEmailName(name);
    if (parsed.problem) {
      claiming.reset();
      setProblem(
        {
          length: t`Use 2 to 64 characters`,
          taken: t`That address isn't available`,
          characters: t`Use letters, numbers, dots, dashes or underscores`,
        }[parsed.problem],
      );
      return;
    }
    setProblem(null);
    claiming.run(parsed.name);
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
        setProblem(null);
        claiming.reset();
      }}
      onSubmitEditing={claim}
    />,
    <SettingsRow
      key="claim"
      accessibilityRole="button"
      tinted
      dimmed={claiming.pending || !name}
      title={t`Claim ${ph({ address: `${name.trim().toLowerCase()}@${domain}` })}`}
      onPress={claim}
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
  // Read on each visit, so an address claimed elsewhere meanwhile shows up.
  const read = useScreenQuery(rpcQuery("bots/emailAddresses"), { onForeground: false });
  // The list read before may be another Space's, so a failed read hides it.
  const email = read.error ? null : read.data;
  const [copied, setCopied] = useState<string | null>(null);
  useTimeout(() => setCopied(null), copied ? 1500 : null);
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
            })
          }
        />
      ))}
    </SettingsGroup>
  );
}
