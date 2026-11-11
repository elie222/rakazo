import { MenuView } from "@expo/ui/community/menu";
import { ph } from "@lingui/core/macro";
import { useLingui } from "@lingui/react/macro";
import type {
  BotSecretMetadata,
  VaultCsv,
  VaultImportResult,
  VaultKind,
  VaultPolicy,
  VaultRevealed,
  VaultUse,
} from "@rakazo/contracts";
import {
  cardExpiry,
  isIdentityConfirmationRequired,
  newVaultImportRows,
  VAULT_KINDS,
  vaultImportCounts,
  vaultImportProblems,
  vaultKind,
} from "@rakazo/contracts";
import { vaultImportProblemLines, vaultImportText, vaultSaveNotice } from "@rakazo/i18n/vault";
import * as Clipboard from "expo-clipboard";
import type { NativeStackNavigationOptions } from "expo-router";
import { useFocusEffect, useLocalSearchParams, useNavigation } from "expo-router";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { Alert, ScrollView, StyleSheet, Text, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BotEmailAddressesGroup } from "../../components/bot-email";
import { useIdentityConfirmation } from "../../components/confirm-identity";
import { ListSearchInput } from "../../components/list-search-input";
import { LoadFailure } from "../../components/load-failure";
import { LongPressMenu } from "../../components/long-press-menu";
import { NativeSegmentedControl } from "../../components/native-segmented-control";
import { NativeSymbol } from "../../components/native-symbol";
import { SettingsGroup, SettingsRow } from "../../components/settings-group";
import { VaultItemEditor } from "../../components/vault-item-editor";
import { VaultItemSheet } from "../../components/vault-item-sheet";
import { VaultTile } from "../../components/vault-tile";
import { mobileTokens } from "../../lib/appearance";
import { presentMessageActionSheet } from "../../lib/message-action-sheet";
import type { MobileBot } from "../../lib/mobile-types";
import { native, useResolvedAppearance, useThemedStyles } from "../../lib/native";
import { iosAtLeast } from "../../lib/native-controls";
import { settingsRpc, settingsTarget } from "../../lib/settings-target";
import { useSideInsets } from "../../lib/side-insets";
import { errorText } from "../../lib/user-error";
import type { VaultBots, VaultItem, VaultSave } from "../../lib/vault";
import {
  billingChoices,
  filterVaultItems,
  readableItem,
  VAULT_SEARCH_MIN_ITEMS,
  vaultItemSubtitle,
  vaultKindLabel,
  vaultKindSymbol,
  vaultKindsPresent,
  withItem,
} from "../../lib/vault";
import { pickVaultCsv } from "../../lib/vault-import";

type RowAction = "edit" | "remove";
const IMPORT = "import";
const IMPORT_TIMEOUT_MS = 120_000;
type Editing = { kind: VaultKind; item?: VaultItem; revealed?: VaultRevealed };

/**
 * Logins, cards, contacts, API keys and variables bots can use. Opened with a Space that keeps its
 * own vault, it edits that Space's items instead of the account's. Show reads a protected value
 * back once the person confirms it's them; the value lives only in the native alert that shows it,
 * never in this screen's state.
 */
export default function Vault() {
  const { spaceId } = useLocalSearchParams<{ spaceId?: string }>();
  const navigation = useNavigation();
  const target = useMemo(() => settingsTarget(spaceId), [spaceId]);
  const rpc = useMemo(() => settingsRpc(target), [target]);
  const scope = target.scope;
  const { t } = useLingui();
  const colorScheme = useResolvedAppearance();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const [items, setItems] = useState<BotSecretMetadata[] | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  // A review plans against the Vault as read, so it waits for a good read.
  const listed = items !== null && !loadError;
  const [attempt, setAttempt] = useState(0);
  const [filter, setFilter] = useState<VaultKind | "all">("all");
  const [query, setQuery] = useState("");
  const [opened, setOpened] = useState<string | null>(null);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [uses, setUses] = useState<{ key: string; list: VaultUse[] } | null>(null);
  // A saved item to open once the editor has gone, so two sheets are never up at once.
  const afterEditing = useRef<{ name: string; notice: string } | null>(null);
  const [notice, setNotice] = useState<{ name: string; text: string } | null>(null);
  // Counts changes, so a read that started before one never shows what it replaced.
  const changes = useRef(0);
  // A value that arrives after the screen lost focus is dropped instead of shown.
  const focused = useRef(false);
  const { withIdentityConfirmation, identityDialog } = useIdentityConfirmation();

  useFocusEffect(
    useCallback(() => {
      focused.current = true;
      return () => {
        focused.current = false;
      };
    }, []),
  );

  useFocusEffect(
    useCallback(() => {
      let current = true;
      const changesAtRead = changes.current;
      void rpc("vault/list", { scope })
        .then((next) => {
          if (!current || changes.current !== changesAtRead) return;
          setItems(next);
          setError(null);
          setLoadError(null);
        })
        .catch((err: unknown) => {
          if (current) setLoadError(errorText(err, t`Something went wrong. Try again.`));
        });
      return () => {
        current = false;
      };
    }, [attempt, rpc, scope, t]),
  );

  useEffect(() => {
    // An item's uses are never shown for another one, or after a read of them fails.
    setUses(null);
    if (!opened) return;
    let current = true;
    void rpc("vault/activity", { scope, name: opened })
      .then((list) => {
        if (current) setUses({ key: `${scope}:${opened}`, list });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [opened, rpc, scope]);

  // Items can be limited to chosen bots unless the saved ones show this server can't.
  const canChooseBots = !items?.length || items.some((item) => item.allBots !== undefined);
  // Read for each edit, so bots added or a Space's vault changed since are what it offers.
  const [picker, setPicker] = useState<{
    bots: MobileBot[];
    spaces: number;
    ownVault: boolean;
  } | null>(null);
  useEffect(() => {
    setPicker(null);
    if (!editing || !canChooseBots) return;
    let current = true;
    // An archived bot the item is limited to is named so, as restoring it brings the choice
    // back, and can be let go of. Archived bots are listed apart; when they can't be read, a
    // chosen one isn't shown, and the editor then offers no choice rather than lose it.
    const chosen = editing.item?.allBots === false ? (editing.item.botIds ?? []) : [];
    void Promise.all([
      rpc("bots/list"),
      scope === "account" ? rpc("spaces/list") : null,
      scope === "account" ? rpc("spaceSettings/overrides") : null,
      chosen.length ? rpc("bots/listArchived").catch(() => []) : [],
    ])
      .then(([list, navigation, overrides, archived]) => {
        if (!current) return;
        setPicker({
          bots: [
            ...list.filter((bot) => !bot.archivedAt),
            ...archived
              .filter(
                (bot) => chosen.includes(bot.id) && !list.some((active) => active.id === bot.id),
              )
              .map((bot) => ({ ...bot, name: `${bot.name} · ${t`Archived`}` })),
          ],
          spaces: navigation?.spaces.length ?? 1,
          ownVault: Boolean(overrides?.includes("credentials")),
        });
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [canChooseBots, editing, rpc, scope]);
  const botsNote = picker?.ownVault
    ? t`This Space keeps its own vault, so its bots can't use account items.`
    : picker && picker.spaces > 1
      ? t`This limits only this Space's bots. Your other Spaces choose for their own.`
      : undefined;

  const startAdding = useCallback((kind: VaultKind) => {
    setOpened(null);
    setEditing({ kind });
  }, []);

  useLayoutEffect(() => {
    if (!iosAtLeast(26)) return;
    navigation.setOptions({
      unstable_headerRightItems: () => [
        {
          type: "menu" as const,
          label: t`New item`,
          accessibilityLabel: t`New item`,
          icon: { type: "sfSymbol" as const, name: "plus" },
          menu: {
            items: [
              ...VAULT_KINDS.map((kind) => ({
                type: "action" as const,
                label: vaultKindLabel(kind),
                icon: { type: "sfSymbol" as const, name: vaultKindSymbol(kind).ios as never },
                onPress: () => startAdding(kind),
              })),
              {
                type: "action" as const,
                label: t`Import CSV`,
                icon: { type: "sfSymbol" as const, name: "square.and.arrow.down" as never },
                disabled: !listed,
                onPress: () => importCsv.current(),
              },
            ],
          },
        },
      ],
    } satisfies NativeStackNavigationOptions);
  }, [listed, navigation, startAdding, t]);

  // Read on this device: the export itself is never uploaded.
  async function reviewImport() {
    if (pending || !listed) return;
    setError(null);
    let csv: VaultCsv | null;
    try {
      csv = await pickVaultCsv();
    } catch (err) {
      setError(errorText(err, t`Could not import`));
      return;
    }
    if (!csv || !focused.current) return;
    if ("error" in csv) {
      Alert.alert(t`Import CSV`, vaultImportText().fileProblems[csv.error]);
      return;
    }
    const { skipped } = csv;
    const { problems: fileProblems } = csv;
    const plan = newVaultImportRows(csv.rows, items ?? [], csv.lines);
    const { labels } = vaultImportText();
    // A short list of the rows left out: the counts already say how many.
    const lines = (result?: VaultImportResult) => {
      const problems = vaultImportProblemLines(vaultImportProblems(fileProblems, plan, result));
      return [
        ...vaultImportCounts(skipped, plan, result).map(
          ([kind, count]) => `${labels[kind]}: ${count}`,
        ),
        ...(problems.length ? [""] : []),
        ...problems,
      ].join("\n");
    };
    async function save() {
      changes.current += 1;
      setPending(true);
      try {
        // Each login is encrypted and saved in turn: 100 took about 4 s without a database.
        const result = await rpc(
          "vault/import",
          { scope, rows: plan.rows },
          { timeoutMs: IMPORT_TIMEOUT_MS },
        );
        const reminder = t`Delete the exported file now. It holds your passwords unencrypted.`;
        // Not over another screen the person has moved to, as a value shown from here isn't.
        if (focused.current) Alert.alert(t`Import CSV`, `${lines(result)}\n\n${reminder}`);
      } catch (err) {
        // Some may have been saved before it stopped, but not by a server that can't import.
        const message = errorText(err, t`Could not import`);
        const partway = t`Some logins may have been saved. Importing the file again skips them.`;
        setError(
          message === t`Update your server to import logins.` ? message : `${message}\n${partway}`,
        );
      } finally {
        setPending(false);
        // Also after a failure, which may come after some logins were saved. A list that can't
        // be read now is read again when the screen is next shown; until then, import waits. A
        // change made while it is read is kept, as the screen's own read keeps it.
        const changesAtRead = changes.current;
        await rpc("vault/list", { scope }).then(
          (next) => {
            if (changes.current !== changesAtRead) return;
            setItems(next);
            setLoadError(null);
          },
          (err: unknown) => setLoadError(errorText(err, t`Something went wrong. Try again.`)),
        );
      }
    }
    Alert.alert(t`Import CSV`, lines(), [
      { text: t`Cancel`, style: "cancel" },
      ...(plan.rows.length ? [{ text: t`Import`, onPress: () => void save() }] : []),
    ]);
  }
  const importCsv = useRef(reviewImport);
  importCsv.current = reviewImport;

  async function save(change: VaultSave, policy?: VaultPolicy, access?: VaultBots) {
    changes.current += 1;
    setError(null);
    const saved = await rpc("vault/put", {
      scope,
      ...change,
      ...access,
      ...(policy ? { policy } : {}),
    });
    setItems((current) => withItem(current ?? [], saved));
    // An older server drops what it doesn't know silently, but the item is saved, so say what.
    const notice = vaultSaveNotice({ ...change, ...access, ...(policy ? { policy } : {}) }, saved);
    if (notice) afterEditing.current = { name: saved.name, notice };
  }

  async function remove(name: string) {
    changes.current += 1;
    setPending(true);
    setError(null);
    try {
      await rpc("vault/remove", { scope, name });
      setItems((current) => current?.filter((entry) => entry.name !== name) ?? null);
      setOpened(null);
      setUses(null);
    } catch (err) {
      setError(errorText(err, t`Could not remove the item`));
    } finally {
      setPending(false);
    }
  }

  function confirmRemove(item: BotSecretMetadata) {
    Alert.alert(t`Remove ${ph({ name: item.title })}?`, undefined, [
      { text: t`Cancel`, style: "cancel" },
      { text: t`Remove`, style: "destructive", onPress: () => void remove(item.name) },
    ]);
  }

  async function show(item: BotSecretMetadata) {
    setPending(true);
    setError(null);
    try {
      const revealed = await withIdentityConfirmation(() =>
        rpc("vault/reveal", { scope, name: item.name }),
      );
      if (focused.current) showRevealed(item.title, revealed);
    } catch (err) {
      // Dismissing the confirmation prompt is the person's choice, not a failure.
      if (!isIdentityConfirmationRequired(err)) {
        setError(errorText(err, t`Could not show the item`));
      }
    } finally {
      setPending(false);
    }
  }

  function showRevealed(title: string, revealed: VaultRevealed) {
    const copy = (text: string) => void Clipboard.setStringAsync(text).catch(() => undefined);
    if ("value" in revealed) {
      Alert.alert(title, revealed.value, [
        { text: t`Copy`, onPress: () => copy(revealed.value) },
        { text: t`Done`, style: "cancel" },
      ]);
      return;
    }
    const fields =
      "card" in revealed
        ? [
            { label: t`Card number`, value: revealed.card.number },
            { label: t`Expires`, value: cardExpiry(revealed.card) },
            ...(revealed.card.cvc ? [{ label: t`Security code`, value: revealed.card.cvc }] : []),
          ]
        : [
            ...revealed.fields,
            ...(revealed.otp ? [{ label: t`Authenticator key`, value: revealed.otp }] : []),
          ];
    Alert.alert(title, fields.map((field) => `${field.label}\n${field.value}`).join("\n\n"), [
      {
        text: t`Copy`,
        // An item can have more fields than an Android alert has buttons, so each gets a sheet row.
        onPress: () =>
          presentMessageActionSheet({
            title,
            actions: fields.map((field) => ({
              text: t`Copy ${ph({ label: field.label })}`,
              onPress: () => copy(field.value),
            })),
            cancel: t`Cancel`,
            more: t`More`,
            colorScheme,
          }),
      },
      { text: t`Done`, style: "cancel" },
    ]);
  }

  /** A login or card opens with its value, after the person confirms it's them, so Save keeps all of it. */
  async function edit(item: BotSecretMetadata) {
    const readable = readableItem(item);
    if (!readable) return;
    const kind = vaultKind(readable.auth.type);
    let revealed: VaultRevealed | undefined;
    if (kind === "login" || kind === "card") {
      setPending(true);
      setError(null);
      try {
        revealed = await withIdentityConfirmation(() =>
          rpc("vault/reveal", { scope, name: readable.name }),
        );
      } catch (err) {
        // Dismissing the confirmation prompt is the person's choice, not a failure.
        if (!isIdentityConfirmationRequired(err)) {
          setError(errorText(err, t`Could not show the item`));
        }
        return;
      } finally {
        setPending(false);
      }
      if (!focused.current) return;
    }
    setOpened(null);
    setEditing({ kind, item: readable, revealed });
  }

  function runAction(item: BotSecretMetadata, action: RowAction) {
    if (pending) return;
    if (action === "edit") void edit(item);
    if (action === "remove") confirmRemove(item);
  }

  const kinds = items ? vaultKindsPresent(items) : [];
  const activeFilter = filter !== "all" && !kinds.includes(filter) ? "all" : filter;
  const shown = items ? filterVaultItems(items, activeFilter, query) : [];
  const failure = error ?? loadError;
  const shownError = error ?? (items ? loadError : null);
  const openedItem = items?.find((item) => item.name === opened);
  const contacts = items ? billingChoices(items) : [];
  const billingTitle = (name?: string) => contacts.find((contact) => contact.key === name)?.label;

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        {failure && !items ? (
          <LoadFailure
            message={failure}
            onRetry={() => {
              setError(null);
              setLoadError(null);
              setAttempt((count) => count + 1);
            }}
          />
        ) : shownError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {shownError}
          </Text>
        ) : null}
        {items && !iosAtLeast(26) ? (
          // Older iOS and Android have no header menu, so New sits above the list.
          <MenuView
            colorScheme={colorScheme}
            title={t`New item`}
            actions={[
              ...VAULT_KINDS.map((kind) => ({ id: kind, title: vaultKindLabel(kind) })),
              { id: IMPORT, title: t`Import CSV`, attributes: { disabled: !listed } },
            ]}
            onPressAction={({ nativeEvent }) =>
              nativeEvent.event === IMPORT
                ? void reviewImport()
                : startAdding(nativeEvent.event as VaultKind)
            }
          >
            {/* A plain view: on Android the menu opens from its own Pressable, which a
                nested Pressable would take the touch from. */}
            <View
              accessible
              accessibilityRole="button"
              accessibilityLabel={t`New item`}
              style={styles.add}
            >
              <NativeSymbol ios="plus" android="add" size={18} />
              <Text style={styles.addLabel}>{t`New item`}</Text>
            </View>
          </MenuView>
        ) : null}
        {items && items.length >= VAULT_SEARCH_MIN_ITEMS ? (
          <ListSearchInput query={query} setQuery={setQuery} />
        ) : null}
        {kinds.length > 1 ? (
          <NativeSegmentedControl
            accessibilityLabel={t`Kind`}
            value={activeFilter}
            onChange={setFilter}
            options={[
              { value: "all" as const, label: t`All` },
              ...kinds.map((kind) => ({ value: kind, label: filterLabel(kind) })),
            ]}
          />
        ) : null}
        {items && items.length === 0 ? (
          <Text style={styles.empty}>{t`Nothing saved yet.`}</Text>
        ) : null}
        {shown.length ? (
          <SettingsGroup>
            {shown.map((item) => {
              const readable = readableItem(item);
              const symbol = readable
                ? vaultKindSymbol(vaultKind(readable.auth.type))
                : { ios: "exclamationmark.triangle", android: "warning-outline" };
              return (
                // A long press opens the row's actions; a tap opens the item.
                <LongPressMenu
                  key={item.name}
                  actions={[
                    ...(readable
                      ? [{ id: "edit", title: t`Edit`, attributes: { disabled: pending } }]
                      : []),
                    {
                      id: "remove",
                      title: t`Remove`,
                      attributes: { destructive: true, disabled: pending },
                    },
                  ]}
                  colorScheme={colorScheme}
                  onPressAction={(event) => {
                    const action = event.nativeEvent.event;
                    if (action === "edit" || action === "remove") runAction(item, action);
                  }}
                  title={item.title}
                >
                  {(onLongPress) => (
                    <SettingsRow
                      accessibilityRole="button"
                      dimmed={pending}
                      onPress={() => {
                        setNotice(null);
                        setOpened(item.name);
                      }}
                      onLongPress={onLongPress}
                      title={item.title}
                      detail={vaultItemSubtitle(item) || undefined}
                      chevron="right"
                      leading={
                        <VaultTile
                          origin={readable?.auth.type === "login" ? item.origin : undefined}
                          style={styles.tile}
                        >
                          <NativeSymbol
                            ios={symbol.ios}
                            android={symbol.android as never}
                            size={17}
                          />
                        </VaultTile>
                      }
                    />
                  )}
                </LongPressMenu>
              );
            })}
          </SettingsGroup>
        ) : null}
        {scope === "account" ? <BotEmailAddressesGroup /> : null}
      </ScrollView>
      {openedItem ? (
        <VaultItemSheet
          item={openedItem}
          billingTitle={billingTitle(openedItem.preview?.card?.billing)}
          uses={uses?.key === `${scope}:${openedItem.name}` ? uses.list : []}
          notice={notice?.name === openedItem.name ? notice.text : undefined}
          busy={pending}
          onClose={() => {
            setOpened(null);
            setNotice(null);
          }}
          onShow={() => void show(openedItem)}
          onEdit={() => void edit(openedItem)}
          onRemove={() => confirmRemove(openedItem)}
        />
      ) : null}
      {editing ? (
        <VaultItemEditor
          kind={editing.kind}
          item={editing.item}
          revealed={editing.revealed}
          contacts={contacts}
          onClose={() => {
            setEditing(null);
            const next = afterEditing.current;
            afterEditing.current = null;
            if (next) {
              setOpened(next.name);
              setNotice({ name: next.name, text: next.notice });
            }
          }}
          bots={canChooseBots && !picker?.ownVault ? picker?.bots : undefined}
          botsNote={botsNote}
          onSave={save}
        />
      ) : null}
      {identityDialog}
    </SafeAreaView>
  );

  function filterLabel(kind: VaultKind) {
    if (kind === "login") return t`Logins`;
    if (kind === "card") return t`Cards`;
    if (kind === "contact") return t`Contacts`;
    if (kind === "api_key") return t`Keys`;
    return t`Variables`;
  }
}

function createStyles() {
  const tokens = mobileTokens();
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.groupedPage },
    content: { width: "100%", padding: 20, gap: 16, paddingBottom: 40 },
    error: { color: tokens.destructive, fontSize: 14 },
    empty: { color: native.secondaryLabel, fontSize: 15, textAlign: "center", paddingVertical: 24 },
    add: { flexDirection: "row", alignItems: "center", gap: 8, alignSelf: "flex-end", padding: 8 },
    addLabel: { color: native.label, fontSize: 17 },
    tile: {
      width: 32,
      height: 32,
      borderRadius: 8,
      alignItems: "center",
      justifyContent: "center",
      backgroundColor: native.fill,
      marginEnd: 12,
    },
  });
}
