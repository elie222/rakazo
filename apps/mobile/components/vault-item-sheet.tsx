import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type { BotSecretMetadata, ContactFields, VaultUse } from "@rakazo/contracts";
import {
  cardExpiry,
  commandVariableName,
  hasVaultAccess,
  otherSitesText,
  vaultKind,
} from "@rakazo/contracts";
import * as Clipboard from "expo-clipboard";
import { useState } from "react";
import { Modal, Platform, ScrollView, StyleSheet, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { formatActivityRelativeTime } from "../lib/activity";
import { native, useThemedStyles } from "../lib/native";
import { siteHost } from "../lib/secret-destination";
import { readableItem, vaultKindLabel, vaultKindSymbol } from "../lib/vault";
import { NativeActionButton } from "./native-action-button";
import { NativeSymbol } from "./native-symbol";
import { SettingsGroup, SettingsRow } from "./settings-group";
import { VaultTile } from "./vault-tile";

type DetailRow = { label: string; value: string; hidden?: boolean };

/**
 * One saved item: what it shows without a reveal, each with copy, and its protected values as dots
 * that Show reveals once the person confirms it's them. The revealed values never enter this sheet.
 */
export function VaultItemSheet({
  item,
  billingTitle,
  uses,
  notice,
  busy,
  onClose,
  onShow,
  onEdit,
  onRemove,
}: {
  item: BotSecretMetadata;
  /** The title of the contact a card is billed to. */
  billingTitle?: string;
  uses: VaultUse[];
  notice?: string;
  busy: boolean;
  onClose: () => void;
  onShow: () => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { t } = useLingui();
  const styles = useThemedStyles(createStyles);
  const insets = useSafeAreaInsets();
  const readable = readableItem(item);
  const kind = readable ? vaultKind(readable.auth.type) : undefined;
  const symbol = kind ? vaultKindSymbol(kind) : { ios: "questionmark", android: "help" };
  const rows = readable ? detailRows(readable, billingTitle) : [];
  const copy = (text: string) => void Clipboard.setStringAsync(text).catch(() => undefined);
  const [usesOpen, setUsesOpen] = useState(false);
  const latest = uses[0];

  function detailRows(entry: NonNullable<typeof readable>, billing?: string): DetailRow[] {
    const { preview } = entry;
    const hidden = { value: "••••••••", hidden: true };
    const list: DetailRow[] = [];
    const add = (label: string, value: string | undefined) => {
      if (value) list.push({ label, value });
    };
    if (entry.auth.type === "login") {
      add(t`Site`, siteHost(entry.origin));
      add(t`Also on`, otherSitesText(entry.alsoOn ?? []));
      add(t`Username`, preview?.username);
      list.push({ label: t`Password`, ...hidden });
      if (preview?.otp) list.push({ label: t`Authenticator key`, ...hidden });
    } else if (entry.auth.type === "card") {
      const card = preview?.card;
      list.push({
        label: t`Card number`,
        value: card ? `•••• ${card.last4}` : "••••",
        hidden: true,
      });
      add(t`Expires`, card ? cardExpiry(card) : undefined);
      add(t`Name on card`, card?.name);
      add(t`Billing address`, billing);
    } else if (entry.auth.type === "contact") {
      const contact: Partial<ContactFields> = preview?.contact ?? {};
      add(t`Full name`, contact.name);
      add(t`Address`, [contact.line1, contact.line2].filter(Boolean).join("\n"));
      add(t`City`, [contact.city, contact.region, contact.postalCode].filter(Boolean).join(", "));
      add(t`Country`, contact.country);
      add(t`Phone`, contact.phone);
      add(t`Email`, contact.email);
    } else if (entry.auth.type === "command") {
      add(t`Variable`, `$${commandVariableName(entry.name)}`);
      list.push({ label: t`Value`, ...hidden });
    } else {
      add(t`Site`, entry.origin);
      add(
        t`Type`,
        entry.auth.type === "header"
          ? t`Header ${ph({ name: entry.auth.name })}`
          : entry.auth.type === "basic"
            ? t`Basic auth (${ph({ username: entry.auth.username })})`
            : t`Bearer token`,
      );
      list.push({ label: t`Value`, ...hidden });
    }
    add(t`When to use`, entry.note);
    if (hasVaultAccess(vaultKind(entry.auth.type)) && entry.policy === "off")
      add(t`Bots`, t`Block`);
    else
      add(
        t`Bots`,
        [
          entry.policy === "ask" ? t`Ask first` : "",
          entry.allBots === false ? (entry.botIds?.length ? t`Chosen bots` : t`No bots`) : "",
        ]
          .filter(Boolean)
          .join(" · "),
      );
    return list;
  }

  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <View
        accessibilityViewIsModal
        style={[
          styles.sheet,
          {
            paddingTop: Platform.OS === "ios" ? 12 : insets.top + 12,
            paddingBottom: insets.bottom,
          },
        ]}
      >
        <View style={styles.header}>
          {usesOpen ? (
            <NativeActionButton
              label={t`Back`}
              onPress={() => setUsesOpen(false)}
              prominence="plain"
            />
          ) : (
            <NativeActionButton label={t`Done`} onPress={onClose} prominence="plain" />
          )}
          {readable && !usesOpen ? (
            <NativeActionButton
              disabled={busy}
              fill={false}
              label={t`Edit`}
              onPress={onEdit}
              prominence="plain"
            />
          ) : null}
        </View>
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.heading}>
            <VaultTile origin={kind === "login" ? item.origin : undefined} style={styles.tile}>
              <NativeSymbol ios={symbol.ios} android={symbol.android as never} size={20} />
            </VaultTile>
            <View style={styles.headingText}>
              <Text accessibilityRole="header" style={styles.title} numberOfLines={2}>
                {item.title}
              </Text>
              {usesOpen ? (
                <Text style={styles.kind}>{t`Activity`}</Text>
              ) : kind ? (
                <Text style={styles.kind}>{vaultKindLabel(kind)}</Text>
              ) : null}
            </View>
          </View>
          {usesOpen ? (
            // Every use on its own page; Back returns to the item.
            <SettingsGroup>
              {uses.map((use, index) => (
                <SettingsRow
                  key={`${use.at}-${index}`}
                  title={use.botName}
                  detail={[
                    use.chat && use.chat.title !== use.botName ? use.chat.title : "",
                    use.site ? siteHost(use.site) : "",
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                  value={formatActivityRelativeTime(use.at)}
                />
              ))}
            </SettingsGroup>
          ) : (
            <>
              {notice ? <Text style={styles.unreadable}>{notice}</Text> : null}
              {readable ? null : (
                <Text style={styles.unreadable}>
                  {t`These saved settings can't be read. Remove it and add it again.`}
                </Text>
              )}
              <SettingsGroup>
                {rows.map((row) => (
                  <SettingsRow
                    key={row.label}
                    accessibilityRole="button"
                    accessibilityHint={row.hidden ? t`Show` : t`Copy`}
                    disabled={busy}
                    title={row.label}
                    value={row.value}
                    onPress={row.hidden ? onShow : () => copy(row.value)}
                    trailing={
                      <NativeSymbol
                        ios={row.hidden ? "eye" : "doc.on.doc"}
                        android={row.hidden ? "eye-outline" : "copy-outline"}
                        color={native.tertiaryLabel}
                        size={16}
                      />
                    }
                  />
                ))}
              </SettingsGroup>
              {latest ? (
                <SettingsGroup>
                  <SettingsRow
                    accessibilityRole="button"
                    title={t`Used ${ph({ when: formatActivityRelativeTime(latest.at) })} by ${ph({ bot: latest.botName })}`}
                    chevron="right"
                    onPress={() => setUsesOpen(true)}
                  />
                </SettingsGroup>
              ) : null}
              <SettingsGroup>
                <SettingsRow
                  key="remove"
                  accessibilityRole="button"
                  destructive
                  disabled={busy}
                  onPress={onRemove}
                  title={t`Remove`}
                />
              </SettingsGroup>
            </>
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}

function createStyles() {
  return StyleSheet.create({
    sheet: { flex: 1, backgroundColor: native.groupedPage },
    header: {
      flexDirection: "row",
      justifyContent: "space-between",
      alignItems: "center",
      paddingHorizontal: 20,
      paddingBottom: 12,
    },
    content: { paddingHorizontal: 20, paddingBottom: 40, gap: 24 },
    heading: { flexDirection: "row", alignItems: "center", gap: 12 },
    headingText: { flex: 1 },
    tile: {
      width: 44,
      height: 44,
      borderRadius: 11,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: native.fill,
    },
    title: { color: native.label, fontSize: 20, fontWeight: "600" },
    kind: { color: native.secondaryLabel, fontSize: 15 },
    unreadable: { color: native.secondaryLabel, fontSize: 15 },
  });
}
