import { useLingui } from "@lingui/react/macro";
import type { CapabilityInstall } from "@rakazo/contracts";
import { useQuery } from "@tanstack/react-query";
import { useFocusEffect, useNavigation, useRouter } from "expo-router";
import { useCallback, useLayoutEffect, useState } from "react";
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
              style={styles.input}
            />
            <NativeActionButton
              disabled={!gitUrl.trim()}
              label={t`Preview`}
              onPress={() => openSkills(gitImportParams(gitUrl))}
              prominence="secondary"
            />
          </View>
        ) : null}
        <View testID="your-skills" style={styles.list}>
          <Text style={styles.section}>{t`Your skills`}</Text>
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
                <SkillSymbol size={17} />
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
            accessibilityRole="button"
            onPress={() => router.push("/skill")}
            style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          >
            <Text style={[styles.title, styles.grow]}>{t`New skill`}</Text>
            <Chevron />
          </Pressable>
        </View>
        <Pressable
          testID="open-bot-templates"
          accessibilityRole="button"
          onPress={() => router.push("/bot-templates")}
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
        >
          <BotTemplateIcon size={LOGO_SIZE} />
          <Text style={[styles.title, styles.grow]}>{t`Templates`}</Text>
          <Chevron />
        </Pressable>
        {skillSets.length ? (
          <View testID="plugin-skill-sets" style={styles.list}>
            <Text style={styles.section}>{t`Plugins`}</Text>
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
          </View>
        ) : null}
        <Text style={styles.section}>{t`Browse`}</Text>
        <TextInput
          value={query}
          onChangeText={setQuery}
          accessibilityLabel={t`Search skills`}
          placeholder={t`Search skills`}
          placeholderTextColor={native.tertiaryLabel}
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="search"
          style={styles.input}
        />
        {state === "partial" ? (
          <View style={styles.row}>
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
        <View testID="skill-packs" style={styles.list}>
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
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

function createStyles() {
  return StyleSheet.create({
    screen: { flex: 1, backgroundColor: native.page },
    content: { padding: 16, gap: 14 },
    card: { gap: 10 },
    list: { gap: 8 },
    input: {
      minHeight: 48,
      borderRadius: 12,
      backgroundColor: native.fillPressed,
      color: native.label,
      paddingHorizontal: 14,
      fontSize: 15,
    },
    row: {
      minHeight: 56,
      paddingHorizontal: 12,
      paddingVertical: 10,
      borderRadius: 14,
      backgroundColor: native.fill,
      flexDirection: "row",
      alignItems: "center",
      gap: 10,
    },
    pressed: { backgroundColor: native.fillPressed },
    section: { color: native.secondaryLabel, fontSize: 13, fontWeight: "500", marginTop: 6 },
    skillMark: {
      width: LOGO_SIZE,
      height: LOGO_SIZE,
      borderRadius: 10,
      backgroundColor: native.fillPressed,
      alignItems: "center",
      justifyContent: "center",
    },
    grow: { flex: 1, gap: 2, minWidth: 0 },
    title: { color: native.label, fontSize: 15, fontWeight: "500" },
    secondary: { color: native.secondaryLabel, fontSize: 13 },
  });
}
