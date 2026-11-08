import type { AgentSkillCatalogEntry } from "@rakazo/contracts";
import { BOT_PACKAGE_MAX_SKILLS } from "@rakazo/contracts";
import {
  createBotPackageExport,
  createBotPackageSkills,
  initialBotPackageExport,
  initialBotPackageSkills,
} from "@rakazo/core";
import { useFocusEffect } from "expo-router";
import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { StyleSheet, Text, TextInput, View } from "react-native";
import type { MobileBotPackageClient } from "../lib/bot-package-client";
import { mobileBotPackageClient } from "../lib/bot-package-client";
import { BotPackageFileError, shareBotPackageFile } from "../lib/bot-package-file";
import { useI18n } from "../lib/i18n";
import type { MobileScope } from "../lib/mobile-scope";
import { captureMobileScope, mobileScopeKey, subscribeMobileScope } from "../lib/mobile-scope";
import { native } from "../lib/native";
import { BotPackageDocumentView, BotPackageLeftOutList } from "./bot-package-document";
import { BotPackageSkillsView } from "./bot-package-skills";
import { NativeActionButton } from "./native-action-button";
import { NativeSwitch } from "./native-switch";

export function NativeBotPackageSkills({
  botId,
  client,
}: {
  botId: string;
  client: MobileBotPackageClient;
}) {
  const { t } = useI18n();
  const [state, setState] = useState(initialBotPackageSkills);
  const manager = useRef<ReturnType<typeof createBotPackageSkills> | null>(null);
  useLayoutEffect(() => {
    let active = true;
    setState(initialBotPackageSkills);
    const skills = createBotPackageSkills({
      botId,
      forBot: (input, signal) => client.request("botPackages/forBot", input, signal),
      activateSkill: (input, signal) => client.request("botPackages/activateSkill", input, signal),
      isCurrent: () => active && client.isCurrent(),
      changed: setState,
    });
    manager.current = skills;
    void skills.refresh();
    return () => {
      active = false;
      skills.dispose();
      manager.current = null;
    };
  }, [client, botId]);
  if (!state.receipt)
    return state.error ? (
      <NativeActionButton
        label={t("Check imported skills")}
        onPress={() => void manager.current?.refresh()}
        prominence="secondary"
      />
    ) : null;
  return (
    <BotPackageSkillsView
      receipt={state.receipt}
      busy={state.phase === "loading" || state.phase === "saving"}
      unknown={state.phase === "unknown"}
      error={Boolean(state.error)}
      onRefresh={() => void manager.current?.refresh()}
      onActivate={(id, name) => void manager.current?.activate(id, name)}
    />
  );
}

function PackageExport({ botId, client }: { botId: string; client: MobileBotPackageClient }) {
  const { t } = useI18n();
  const [state, setState] = useState(initialBotPackageExport);
  const [skills, setSkills] = useState<AgentSkillCatalogEntry[]>([]);
  const [selection, setSelection] = useState<Set<string>>(new Set());
  const [includeMemory, setIncludeMemory] = useState(false);
  const [query, setQuery] = useState("");
  const [visible, setVisible] = useState(50);
  const requested = useRef<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [reload, setReload] = useState(0);
  const manager = useRef<ReturnType<typeof createBotPackageExport> | null>(null);
  useLayoutEffect(() => {
    let active = true;
    const exporter = createBotPackageExport({
      export: (input, signal) => client.request("botPackages/export", input, signal),
      deliver: (result, signal) =>
        shareBotPackageFile(result.json, () => active && client.isCurrent() && !signal.aborted),
      isCurrent: () => active && client.isCurrent(),
      changed: setState,
    });
    manager.current = exporter;
    return () => {
      active = false;
      exporter.dispose();
      manager.current = null;
    };
  }, [client]);
  useLayoutEffect(() => {
    let active = true;
    const valid = () => active && client.isCurrent();
    setSkills([]);
    setLoading(true);
    setLoadError(false);
    void client
      .request("agentSkills/list", {})
      .then((list) => {
        if (valid()) {
          setSkills(list.filter((skill) => skill.source !== "builtin"));
          setLoading(false);
        }
      })
      .catch(() => {
        if (valid()) {
          setLoadError(true);
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [client, reload]);
  const busy = state.phase === "exporting" || state.phase === "delivering";
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return skills.filter(
      (skill) => !needle || `${skill.name}\n${skill.description}`.toLowerCase().includes(needle),
    );
  }, [skills, query]);
  const selectionKey = JSON.stringify([includeMemory, [...selection].sort()]);
  function invalidate() {
    requested.current = null;
    manager.current?.invalidate();
  }
  return (
    <View style={styles.section} testID="bot-package-export">
      <View style={styles.row}>
        <Text style={styles.text}>{t("Include memory")}</Text>
        <NativeSwitch
          accessibilityLabel={t("Include memory")}
          value={includeMemory}
          disabled={busy}
          onValueChange={(checked) => {
            invalidate();
            setIncludeMemory(checked);
          }}
        />
      </View>
      <Text style={styles.heading}>{t("Shared skills (optional)")}</Text>
      <TextInput
        accessibilityLabel={t("Search shared skills")}
        value={query}
        maxLength={200}
        editable={!busy}
        onChangeText={(value) => {
          setQuery(value);
          setVisible(50);
        }}
        autoCapitalize="none"
        autoCorrect={false}
        style={styles.input}
      />
      <Text style={styles.secondary}>
        {t("Selected skills: {count}", { count: selection.size })}
      </Text>
      {selection.size ? (
        <NativeActionButton
          label={t("Clear selection")}
          disabled={busy}
          onPress={() => {
            invalidate();
            setSelection(new Set());
          }}
          prominence="quiet"
        />
      ) : null}
      {loading ? <Text style={styles.text}>{t("Loading…")}</Text> : null}
      {loadError ? (
        <>
          <Text accessibilityRole="alert" style={styles.secondary}>
            {t("Could not load skills.")}
          </Text>
          <NativeActionButton
            label={t("Retry")}
            onPress={() => setReload((value) => value + 1)}
            prominence="secondary"
          />
        </>
      ) : null}
      {filtered.slice(0, visible).map((skill) => (
        <View key={skill.id} style={styles.row}>
          <Text style={styles.skill}>{skill.name}</Text>
          <NativeSwitch
            accessibilityLabel={skill.name}
            value={selection.has(skill.id)}
            disabled={
              busy || (!selection.has(skill.id) && selection.size >= BOT_PACKAGE_MAX_SKILLS)
            }
            onValueChange={(checked) => {
              invalidate();
              setSelection((prior) => {
                const next = new Set(prior);
                if (checked) next.add(skill.id);
                else next.delete(skill.id);
                return next;
              });
            }}
          />
        </View>
      ))}
      {filtered.length > visible ? (
        <NativeActionButton
          label={t("Show more")}
          disabled={busy}
          onPress={() => setVisible((value) => value + 50)}
          prominence="quiet"
        />
      ) : null}
      <NativeActionButton
        label={state.phase === "exporting" ? t("Exporting…") : t("Preview package")}
        busy={busy}
        disabled={busy || loading || loadError}
        onPress={() => {
          requested.current = selectionKey;
          void manager.current?.run({ botId, skillIds: [...selection], includeMemory });
        }}
      />
      {state.error ? (
        <Text accessibilityRole="alert" style={styles.secondary}>
          {state.error instanceof BotPackageFileError && state.error.code === "cache_full"
            ? t("Share cache is full. Try again after older exports expire.")
            : t("Could not export this package.")}
        </Text>
      ) : null}
      {state.result && requested.current === selectionKey ? (
        <>
          <BotPackageDocumentView document={state.result.document} />
          <BotPackageLeftOutList items={state.result.leftOut} />
          {state.phase === "review" ? (
            <NativeActionButton
              label={t("Share package")}
              onPress={() => void manager.current?.confirm()}
            />
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function ToolsEditor({ botId, scope }: { botId: string; scope: MobileScope }) {
  const { t } = useI18n();
  const [client, setClient] = useState<MobileBotPackageClient | null>(null);
  const [open, setOpen] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reload, setReload] = useState(0);
  useFocusEffect(
    useCallback(() => {
      let active = true;
      setClient(null);
      setOpen(false);
      setFailed(false);
      void mobileBotPackageClient(scope, () => active)
        .then((next) => {
          if (next.isCurrent()) setClient(next);
        })
        .catch(() => {
          if (active) setFailed(true);
        });
      return () => {
        active = false;
        setClient(null);
        setOpen(false);
      };
    }, [scope, reload]),
  );
  return (
    <View style={styles.section} testID="bot-package-tools">
      {failed ? (
        <NativeActionButton
          label={t("Retry package settings")}
          onPress={() => setReload((value) => value + 1)}
          prominence="secondary"
        />
      ) : null}
      <NativeActionButton
        label={t("Export package")}
        disabled={!client}
        onPress={() => setOpen(!open)}
        prominence="secondary"
      />
      {open && client ? <PackageExport key={botId} botId={botId} client={client} /> : null}
      {client ? <NativeBotPackageSkills botId={botId} client={client} /> : null}
    </View>
  );
}

export function NativeBotPackageTools({ botId }: { botId: string }) {
  const key = useSyncExternalStore(subscribeMobileScope, mobileScopeKey, mobileScopeKey);
  const scope = useMemo(captureMobileScope, [key]);
  return <ToolsEditor key={`${key}:${botId}`} botId={botId} scope={scope} />;
}

const styles = StyleSheet.create({
  section: { gap: 14, marginTop: 12 },
  row: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 },
  heading: { fontSize: 15, fontWeight: "600", color: native.label },
  text: { fontSize: 14, color: native.label },
  skill: { flex: 1, fontSize: 14, color: native.label },
  secondary: { fontSize: 14, color: native.secondaryLabel },
  input: {
    fontSize: 14,
    color: native.label,
    backgroundColor: native.fill,
    padding: 12,
    borderRadius: 10,
  },
});
