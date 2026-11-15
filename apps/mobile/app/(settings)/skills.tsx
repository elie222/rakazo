import { useLingui } from "@lingui/react/macro";
import type { CapabilityInstall } from "@rakazo/contracts";
import { fontWeight, typeScale } from "@rakazo/ui-tokens";
import { useQuery } from "@tanstack/react-query";
import { useFocusEffect, useNavigation, useRouter } from "expo-router";
import type { ReactNode } from "react";
import { Children, Fragment, isValidElement, useCallback, useLayoutEffect, useState } from "react";
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { BotTemplateIcon } from "../../components/bot-template-icon";
import { NativeActionButton } from "../../components/native-action-button";
import { NativeSymbol } from "../../components/native-symbol";
import { PluginIcon } from "../../components/plugin-icon";
import { Chevron } from "../../components/row-accessories";
import { SkillSymbol } from "../../components/skill-symbol";
import { native, useThemedStyles } from "../../lib/native";
import { iosAtLeast } from "../../lib/native-controls";
import type { PluginParams } from "../../lib/plugin-marketplace";
import {
  gitImportParams,
  pluginParams,
  pluginSite,
  pluginSkillCount,
  skillPacks,
} from "../../lib/plugin-marketplace";
import { queryClient, rpcQuery } from "../../lib/query";
import { useSideInsets } from "../../lib/side-insets";

const LOGO_SIZE = 32;

/** Your skills in this space, the skills plugins added, and skill packs to browse. */
export default function SkillsScreen() {
  const navigation = useNavigation();
  const router = useRouter();
  const sideInsets = useSideInsets();
  const styles = useThemedStyles(createStyles);
  const { t } = useLingui();
  const skills = useQuery(rpcQuery("agentSkills/list"), queryClient);
  const catalog = useQuery(rpcQuery("marketplace/catalog", { query: "" }), queryClient);
  const capabilities = useQuery(rpcQuery("capabilities/list"), queryClient);
  const [retrying, setRetrying] = useState(false);
  const [query, setQuery] = useState("");
  const [importing, setImporting] = useState(false);
  const [gitUrl, setGitUrl] = useState("");
  const { refetch: refetchSkills } = skills;
  const { refetch: refetchCatalog } = catalog;
  const { refetch: refetchCapabilities } = capabilities;

  // Your skills refresh alongside; Retry waits on the browse reads only.
  const load = useCallback(() => {
    void refetchSkills();
    return Promise.all([refetchCatalog(), refetchCapabilities()]);
  }, [refetchSkills, refetchCatalog, refetchCapabilities]);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // Plugin skills are listed by their plugin, not one by one.
  const ownSkills = (skills.data ?? []).filter((skill) => skill.source !== "plugin");
  const entries = catalog.data?.entries ?? [];
  const installs = (capabilities.data ?? []).filter((row) => row.kind === "plugin");
  const state =
    retrying || !(catalog.isError || capabilities.isError || (catalog.data && capabilities.data))
      ? "loading"
      : catalog.isError || capabilities.isError || catalog.data?.unavailableRegistries.length
        ? "partial"
        : "ready";

  useLayoutEffect(() => {
    const toggle = () => setImporting((open) => !open);
    navigation.setOptions(
      iosAtLeast(26)
        ? {
            unstable_headerRightItems: () => [
              { type: "button" as const, label: t`From GitHub`, onPress: toggle },
            ],
          }
        : {
            headerRight: () => (
              <NativeActionButton
                fill={false}
                label={t`From GitHub`}
                onPress={toggle}
                prominence="secondary"
              />
            ),
          },
    );
  }, [navigation, t]);

  const installed = new Set(installs.map((row) => row.source));
  const packs = skillPacks(entries, query);
  const skillSets = installs.filter((install) => pluginSkillCount(install) > 0);
  const openSkills = (params: PluginParams) =>
    router.push({ pathname: "/plugin", params: { ...params, skillsOnly: "1" } });
  function setParams(install: CapabilityInstall): PluginParams {
    const entry = entries.find((row) => row.installedSource === install.source);
    return entry
      ? pluginParams(entry)
      : { source: install.source, installedSource: install.source, name: install.name };
  }

  return (
    <SafeAreaView edges={["bottom"]} style={styles.screen}>
      <ScrollView
        style={sideInsets}
        contentContainerStyle={styles.content}
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
      >
        {importing ? (
          <View testID="plugin-git-import" style={styles.card}>
            <TextInput
              value={gitUrl}
              onChangeText={setGitUrl}
              accessibilityLabel={t`Plugin GitHub URL`}
              placeholder="https://github.com/owner/plugin"
              placeholderTextColor={native.tertiaryLabel}
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              keyboardType="url"
              maxLength={2048}
              style={[styles.field, styles.input]}
            />
            <NativeActionButton
              disabled={!gitUrl.trim()}
              label={t`Preview`}
              onPress={() => openSkills(gitImportParams(gitUrl))}
              prominence="secondary"
            />
          </View>
        ) : null}
        <View testID="your-skills" style={styles.section}>
          <Text style={styles.label}>{t`Your skills`}</Text>
          <Group>
            {ownSkills.map((skill) => (
              <Pressable
                key={skill.id}
                testID="own-skill"
                accessibilityRole="button"
                accessibilityLabel={skill.name}
                onPress={() => router.push({ pathname: "/skill", params: { id: skill.id } })}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              >
                <View style={styles.skillMark}>
                  <SkillSymbol size={18} />
                </View>
                <View style={styles.grow}>
                  <Text numberOfLines={1} style={styles.title}>
                    {skill.name}
                  </Text>
                  {skill.description ? (
                    <Text numberOfLines={1} style={styles.secondary}>
                      {skill.description}
                    </Text>
                  ) : null}
                </View>
                <Chevron />
              </Pressable>
            ))}
            <Pressable
              key="new"
              accessibilityRole="button"
              onPress={() => router.push("/skill")}
              style={({ pressed }) => [styles.row, pressed && styles.pressed]}
            >
              <Text style={[styles.title, styles.grow]}>{t`New skill`}</Text>
              <Chevron />
            </Pressable>
          </Group>
        </View>
        <Group>
          <Pressable
            key="templates"
            testID="open-bot-templates"
            accessibilityRole="button"
            onPress={() => router.push("/bot-templates")}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <BotTemplateIcon size={LOGO_SIZE} />
            <Text style={[styles.title, styles.grow]}>{t`Templates`}</Text>
            <Chevron />
          </Pressable>
        </Group>
        {skillSets.length ? (
          <View testID="plugin-skill-sets" style={styles.section}>
            <Text style={styles.label}>{t`Plugins`}</Text>
            <Group>
              {skillSets.map((install) => {
                const params = setParams(install);
                const count = pluginSkillCount(install);
                return (
                  <Pressable
                    key={install.id}
                    testID="plugin-skill-set"
                    accessibilityRole="button"
                    accessibilityLabel={params.name}
                    onPress={() => openSkills(params)}
                    style={({ pressed }) => [styles.row, pressed && styles.pressed]}
                  >
                    <PluginIcon
                      logo={params.logo}
                      name={params.name}
                      site={params.site}
                      size={LOGO_SIZE}
                    />
                    <View style={styles.grow}>
                      <Text numberOfLines={1} style={styles.title}>
                        {params.name}
                      </Text>
                      <Text numberOfLines={1} style={styles.secondary}>
                        {count === 1 ? t`1 skill` : t`${count} skills`}
                      </Text>
                    </View>
                    <Chevron />
                  </Pressable>
                );
              })}
            </Group>
          </View>
        ) : null}
        <View style={styles.section}>
          <Text style={styles.label}>{t`Browse`}</Text>
          <View style={[styles.field, styles.search]}>
            <NativeSymbol
              android="search"
              color={native.secondaryLabel}
              ios="magnifyingglass"
              size={22}
            />
            <TextInput
              value={query}
              onChangeText={setQuery}
              accessibilityLabel={t`Search skills`}
              placeholder={t`Search skills`}
              placeholderTextColor={native.tertiaryLabel}
              autoCapitalize="none"
              autoCorrect={false}
              returnKeyType="search"
              style={[styles.input, styles.grow]}
            />
          </View>
        </View>
        {state === "partial" ? (
          <View style={styles.notice}>
            <Text style={[styles.secondary, styles.grow]}>
              {t`Some plugins could not be loaded.`}
            </Text>
            <NativeActionButton
              fill={false}
              label={t`Retry`}
              onPress={() => {
                setRetrying(true);
                void load().finally(() => setRetrying(false));
              }}
              prominence="secondary"
            />
          </View>
        ) : null}
        {state === "loading" ? (
          <ActivityIndicator color={native.secondaryLabel} accessibilityLabel={t`Loading…`} />
        ) : null}
        <View testID="skill-packs">
          <Group>
            {packs.map((entry) => (
              <Pressable
                key={entry.id}
                accessibilityRole="button"
                accessibilityLabel={entry.displayName}
                onPress={() => openSkills(pluginParams(entry))}
                style={({ pressed }) => [styles.row, pressed && styles.pressed]}
              >
                <PluginIcon
                  logo={entry.logo}
                  name={entry.displayName}
                  site={pluginSite(entry)}
                  size={LOGO_SIZE}
                />
                <View style={styles.grow}>
                  <Text numberOfLines={1} style={styles.title}>
                    {entry.displayName}
                  </Text>
                  {entry.description ? (
                    <Text numberOfLines={1} style={styles.secondary}>
                      {entry.description}
                    </Text>
                  ) : null}
                </View>
                {installed.has(entry.installedSource) ? (
                  <Text style={styles.secondary}>{t`Added`}</Text>
                ) : (
                  <Chevron />
                )}
              </Pressable>
            ))}
          </Group>
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

/** One rounded list: the rows share a raised surface, divided by hairlines. */
function Group({ children }: { children: ReactNode }) {
  const styles = useThemedStyles(createStyles);
  const rows = Children.toArray(children).filter(isValidElement);
  if (rows.length === 0) return null;
  return (
    <View style={styles.group}>
      {rows.map((row, index) => (
        <Fragment key={row.key}>
          {index > 0 ? <View style={styles.divider} /> : null}
          {row}
        </Fragment>
      ))}
    </View>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { paddingHorizontal: 16, paddingTop: 16, paddingBottom: 32, gap: 20 },
    card: { gap: 12 },
    section: { gap: 8 },
    label: { color: native.secondaryLabel, ...typeScale.caption, paddingStart: 18 },
    group: {
      borderRadius: 22,
      borderCurve: "continuous",
      borderWidth: 1,
      borderColor: native.separator,
      backgroundColor: native.groupedCell,
      overflow: "hidden",
    },
    divider: { height: 1, backgroundColor: native.separator },
    field: {
      minHeight: 56,
      borderRadius: 28,
      borderWidth: 1,
      borderColor: native.separator,
      backgroundColor: native.groupedCell,
      paddingHorizontal: 20,
    },
    search: { flexDirection: "row", alignItems: "center", gap: 12 },
    input: { minHeight: 54, color: native.label, fontSize: 18 },
    row: {
      minHeight: 64,
      paddingStart: 18,
      paddingEnd: 16,
      paddingVertical: 14,
      flexDirection: "row",
      alignItems: "center",
      gap: 14,
    },
    notice: { flexDirection: "row", alignItems: "center", gap: 12, paddingStart: 18 },
    pressed: { backgroundColor: native.fillPressed },
    skillMark: {
      width: LOGO_SIZE,
      height: LOGO_SIZE,
      borderRadius: LOGO_SIZE / 2,
      backgroundColor: native.fill,
      alignItems: "center",
      justifyContent: "center",
    },
    grow: { flex: 1, gap: 2, minWidth: 0 },
    title: { color: native.label, ...typeScale.cardTitle, fontWeight: fontWeight.regular },
    secondary: { color: native.secondaryLabel, ...typeScale.secondary },
  });
}
