import { BOT_NAME_MAX_LENGTH, BOT_PACKAGE_MAX_BYTES } from "@rakazo/contracts";
import type { BotPackageImportState } from "@rakazo/core";
import { createBotPackageImport } from "@rakazo/core";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import type { MobileBotPackageClient } from "../lib/bot-package-client";
import { mobileBotPackageClient } from "../lib/bot-package-client";
import { pickBotPackageFile } from "../lib/bot-package-file";
import { useI18n } from "../lib/i18n";
import type { MobileScope } from "../lib/mobile-scope";
import { native } from "../lib/native";
import { BotPackageDocumentView, BotPackageLeftOutList } from "./bot-package-document";
import { NativeBotPackageSkills } from "./bot-package-tools";
import { NativeActionButton } from "./native-action-button";
import { NativeSwitch } from "./native-switch";

export function NativeBotPackageImport({
  scope,
  onOpen,
  onConnections,
  onClose,
}: {
  scope: MobileScope;
  onOpen(botId: string, name: string): void;
  onConnections(): void;
  onClose(): void;
}) {
  const { t } = useI18n();
  const [state, setState] = useState<BotPackageImportState | null>(null);
  const [client, setClient] = useState<MobileBotPackageClient | null>(null);
  const [fileError, setFileError] = useState(false);
  const [initializationError, setInitializationError] = useState(false);
  const [reload, setReload] = useState(0);
  const [reading, setReading] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  const manager = useRef<ReturnType<typeof createBotPackageImport> | null>(null);
  const fileGeneration = useRef(0);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      let review: ReturnType<typeof createBotPackageImport> | null = null;
      setState(null);
      setClient(null);
      setReading(false);
      setFileError(false);
      setInitializationError(false);
      setRecentOpen(false);
      void mobileBotPackageClient(scope, () => active)
        .then((next) => {
          if (!next.isCurrent()) return;
          setClient(next);
          review = createBotPackageImport({
            preview: (input, signal) => next.request("botPackages/preview", input, signal),
            import: (input, signal) => next.request("botPackages/import", input, signal),
            status: (input, signal) => next.request("botPackages/status", input, signal),
            recent: (signal) => next.request("botPackages/recent", {}, signal),
            resume: (input, signal) => next.request("botPackages/resume", input, signal),
            cancel: (input, signal) => next.request("botPackages/cancel", input, signal),
            newNonce: () =>
              globalThis.crypto?.randomUUID?.() ??
              `package-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`,
            isCurrent: next.isCurrent,
            changed: setState,
          });
          manager.current = review;
        })
        .catch(() => {
          if (active) setInitializationError(true);
        });
      return () => {
        active = false;
        fileGeneration.current++;
        review?.dispose();
        manager.current = null;
        setClient(null);
        setState(null);
      };
    }, [scope, reload]),
  );
  const phase = state?.phase ?? "editing";
  const receipt = state?.receipt;
  const preview = state?.preview;
  const busy = phase === "importing" || phase === "checking";
  const locked =
    !client ||
    busy ||
    phase === "unknown" ||
    receipt?.status === "importing" ||
    receipt?.status === "failed";
  function edit(input: { source?: string; name?: string; includeMemory?: boolean }) {
    fileGeneration.current++;
    setReading(false);
    setFileError(false);
    manager.current?.edit(input);
  }
  async function pick() {
    if (!client?.isCurrent()) return;
    const version = ++fileGeneration.current;
    const valid = () => client.isCurrent() && version === fileGeneration.current;
    setReading(true);
    setFileError(false);
    try {
      const source = await pickBotPackageFile(valid);
      if (valid() && source !== null) manager.current?.edit({ source });
    } catch {
      if (valid()) setFileError(true);
    } finally {
      if (valid()) setReading(false);
    }
  }
  return (
    <View style={styles.section} testID="bot-package-import">
      <Text style={styles.heading}>{t("Import bot")}</Text>
      {initializationError ? (
        <>
          <Text accessibilityRole="alert" style={styles.secondary}>
            {t("Could not open package editor.")}
          </Text>
          <NativeActionButton
            label={t("Retry")}
            prominence="secondary"
            onPress={() => setReload((value) => value + 1)}
          />
        </>
      ) : null}
      {phase !== "completed" ? (
        <>
          <Text style={styles.text}>{t("Bot package or Grok JSON")}</Text>
          <TextInput
            accessibilityLabel={t("Bot package or Grok JSON")}
            multiline
            value={state?.source ?? ""}
            maxLength={BOT_PACKAGE_MAX_BYTES}
            editable={!locked}
            onChangeText={(source) => edit({ source })}
            autoCorrect={false}
            autoCapitalize="none"
            style={[styles.input, styles.source]}
          />
          <NativeActionButton
            label={t("Choose package file")}
            disabled={locked || reading}
            busy={reading}
            onPress={() => void pick()}
            prominence="secondary"
          />
          <Text style={styles.text}>{t("Name")}</Text>
          <TextInput
            accessibilityLabel={t("Imported bot name")}
            value={state?.name ?? ""}
            maxLength={BOT_NAME_MAX_LENGTH}
            placeholder={preview?.document.profile.name ?? ""}
            editable={!locked}
            onChangeText={(name) => edit({ name })}
            style={styles.input}
          />
          <View style={styles.row}>
            <Text style={styles.text}>
              {t("Include memory")}
              {preview ? ` · ${preview.availableMemoryCount}` : ""}
            </Text>
            <NativeSwitch
              accessibilityLabel={t("Include memory")}
              value={state?.includeMemory ?? false}
              disabled={locked}
              onValueChange={(includeMemory) => edit({ includeMemory })}
            />
          </View>
          <NativeActionButton
            label={phase === "previewing" ? t("Previewing…") : t("Preview")}
            disabled={locked || reading || !state?.source.trim()}
            busy={phase === "previewing"}
            onPress={() => void manager.current?.preview()}
            prominence="secondary"
          />
        </>
      ) : null}
      {fileError ? (
        <Text accessibilityRole="alert" style={styles.secondary}>
          {t("Could not read this package. Use a UTF-8 JSON file up to 4 MiB.")}
        </Text>
      ) : null}
      {state?.error ? (
        <Text accessibilityRole="alert" style={styles.secondary}>
          {phase === "editing" || phase === "review"
            ? t("Could not preview this package.")
            : t("Could not confirm import. Check status before trying again.")}
        </Text>
      ) : null}
      {preview && phase !== "completed" ? (
        <>
          <BotPackageDocumentView document={preview.document} />
          <BotPackageLeftOutList items={preview.leftOut} />
          <Text style={styles.secondary}>
            {t("Skills stay off. Routines stay paused. Connections need setup.")}
          </Text>
          <Text style={styles.secondary}>
            {t("Models, credentials, files, and chat history are not imported.")}
          </Text>
          {phase === "review" ? (
            <NativeActionButton
              label={t("Import as new bot")}
              onPress={() => void manager.current?.confirm()}
            />
          ) : null}
        </>
      ) : null}
      {phase === "unknown" || receipt?.status === "importing" || receipt?.status === "failed" ? (
        <>
          <NativeActionButton
            label={t("Check status")}
            disabled={busy}
            onPress={() => void manager.current?.check()}
            prominence="secondary"
          />
          {state?.canRetry && (receipt || preview) ? (
            <NativeActionButton
              label={t("Resume import")}
              disabled={busy}
              onPress={() =>
                void (receipt ? manager.current?.resume() : manager.current?.confirm())
              }
              prominence="secondary"
            />
          ) : null}
          <NativeActionButton
            label={t("Cancel import")}
            disabled={busy}
            onPress={() => void manager.current?.cancel()}
            prominence="secondary"
          />
        </>
      ) : null}
      {receipt ? (
        <View style={styles.section} testID="bot-package-receipt">
          <Text selectable style={styles.heading}>
            {receipt.botName}
          </Text>
          <Text style={styles.text}>
            {receipt.status === "completed"
              ? t("Bot imported")
              : receipt.status === "removed"
                ? t("This imported bot was removed.")
                : receipt.status === "cancelled"
                  ? t("Import cancelled.")
                  : t("Import needs attention.")}
          </Text>
          <BotPackageLeftOutList items={receipt.leftOut} />
          {receipt.status === "completed" && receipt.botId && client ? (
            <>
              <NativeBotPackageSkills botId={receipt.botId} client={client} />
              {receipt.connections.length ? (
                <View style={styles.section}>
                  {receipt.connections.map((connection) => (
                    <Text key={connection.id} selectable style={styles.text}>
                      {connection.name} · {connection.note}
                    </Text>
                  ))}
                  <NativeActionButton
                    label={t("Set up connections")}
                    onPress={() => {
                      if (client.isCurrent()) onConnections();
                    }}
                    prominence="secondary"
                  />
                </View>
              ) : null}
              <NativeActionButton
                label={t("Open bot")}
                onPress={() => {
                  if (client.isCurrent() && receipt.botId) onOpen(receipt.botId, receipt.botName);
                }}
              />
            </>
          ) : null}
          {phase === "completed" ? (
            <NativeActionButton
              label={t("Import another bot")}
              onPress={() => manager.current?.reset()}
              prominence="secondary"
            />
          ) : null}
        </View>
      ) : null}
      <NativeActionButton
        label={t("Recent imports")}
        disabled={locked}
        onPress={() => {
          setRecentOpen(!recentOpen);
          if (!recentOpen) void manager.current?.loadRecent();
        }}
        prominence="quiet"
      />
      {recentOpen ? (
        <View style={styles.section} testID="bot-package-recent">
          {state?.recentLoading ? <Text style={styles.text}>{t("Loading…")}</Text> : null}
          {state?.recentError ? (
            <Text accessibilityRole="alert" style={styles.secondary}>
              {t("Could not load recent imports.")}
            </Text>
          ) : null}
          {state?.recent.map((item) => (
            <View key={item.importId}>
              <Text selectable style={styles.text}>
                {item.botName}
              </Text>
              <NativeActionButton
                label={t("Review import")}
                disabled={locked}
                onPress={() => void manager.current?.recover(item.clientNonce)}
                prominence="secondary"
              />
            </View>
          ))}
        </View>
      ) : null}
      <NativeActionButton label={t("Close")} onPress={onClose} prominence="quiet" />
    </View>
  );
}

const styles = StyleSheet.create({
  section: { gap: 16 },
  heading: { fontSize: 17, fontWeight: "600", color: native.label },
  text: { fontSize: 14, color: native.label },
  secondary: { fontSize: 14, color: native.secondaryLabel },
  input: {
    fontSize: 14,
    color: native.label,
    backgroundColor: native.fill,
    padding: 12,
    borderRadius: 10,
  },
  source: { minHeight: 160, textAlignVertical: "top" },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
});
