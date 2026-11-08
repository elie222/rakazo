import type { ConnectionCatalogItem, PluginMarketplaceEntry } from "@rakazo/contracts";
import { OTHER_PLUGINS } from "@rakazo/core";
import type { ReactNode } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { native, useThemedStyles } from "../lib/native";
import type { PluginParams } from "../lib/plugin-marketplace";
import { pluginParams, pluginSite } from "../lib/plugin-marketplace";
import { createIntegrationsStyles, LOGO_SIZE } from "./integrations-styles";
import { NativeActionButton } from "./native-action-button";
import { PluginIcon } from "./plugin-icon";
import { Chevron } from "./row-accessories";

const SECTION_SIZE = 4;
export const PLUGIN_PAGE_SIZE = 20;

/** The plugin catalog: sections by category, or the matches while searching or filtering. */
export function PluginSection({
  pluginsState,
  catalogReady,
  onRetry,
  filtering,
  pluginMatches,
  brandMatches,
  pluginCount,
  onShowMore,
  plugins,
  categories,
  categoryLabel,
  onViewCategory,
  installedSources,
  columns,
  onOpenPlugin,
  renderAppTile,
}: {
  pluginsState: "loading" | "ready" | "partial";
  catalogReady: boolean;
  onRetry: () => void;
  filtering: boolean;
  pluginMatches: PluginMarketplaceEntry[];
  brandMatches: { item: ConnectionCatalogItem; entry: PluginMarketplaceEntry }[];
  pluginCount: number;
  onShowMore: () => void;
  plugins: PluginMarketplaceEntry[];
  categories: string[];
  categoryLabel: (name: string) => string;
  onViewCategory: (name: string) => void;
  installedSources: Set<string>;
  columns: number;
  onOpenPlugin: (params: PluginParams) => void;
  /** A managed app standing in for a plugin, shown as the catalog shows it. */
  renderAppTile: (item: ConnectionCatalogItem) => ReactNode;
}) {
  const styles = useThemedStyles(createIntegrationsStyles);
  const { t } = useI18n();
  if (pluginsState === "loading") {
    return catalogReady ? (
      <ActivityIndicator color={native.secondaryLabel} accessibilityLabel={t("Loading…")} />
    ) : null;
  }
  const failed =
    pluginsState === "partial" ? (
      <View style={styles.catalogStack}>
        <Text style={styles.secondary}>{t("Some plugins could not be loaded.")}</Text>
        <NativeActionButton
          label={t("Retry")}
          fill={false}
          onPress={onRetry}
          prominence="secondary"
        />
      </View>
    ) : null;
  if (filtering) {
    return (
      <>
        {failed}
        {pluginMatches.length || brandMatches.length ? (
          <View
            testID="plugin-results"
            style={columns === 2 ? styles.catalogGrid : styles.catalogStack}
          >
            {brandMatches.map(({ item }) => renderAppTile(item))}
            {pluginMatches.slice(0, pluginCount).map((entry) => (
              <PluginRow
                key={entry.id}
                entry={entry}
                installed={installedSources.has(entry.installedSource)}
                columns={columns}
                onOpen={onOpenPlugin}
              />
            ))}
          </View>
        ) : null}
        {pluginCount < pluginMatches.length ? (
          <NativeActionButton label={t("Show more")} onPress={onShowMore} prominence="secondary" />
        ) : null}
      </>
    );
  }
  const uncategorized = plugins.filter((entry) => !entry.category);
  const sections: Array<[string, PluginMarketplaceEntry[]]> = [
    ...categories.map((name): [string, PluginMarketplaceEntry[]] => [
      name,
      plugins.filter((entry) => entry.category === name),
    ]),
    ...(uncategorized.length
      ? [[OTHER_PLUGINS, uncategorized] as [string, PluginMarketplaceEntry[]]]
      : []),
  ].filter(([, entries]) => entries.length);
  return (
    <>
      {failed}
      {sections.map(([name, entries]) => (
        <View key={name} testID="plugin-section" style={styles.catalogStack}>
          <View style={styles.sectionHeader}>
            <Text style={styles.sectionTitle}>
              {name === OTHER_PLUGINS ? t("More") : categoryLabel(name)}
            </Text>
            {entries.length > SECTION_SIZE ? (
              <Pressable
                accessibilityRole="button"
                hitSlop={8}
                onPress={() => onViewCategory(name)}
              >
                <Text style={styles.link}>{t("View all")}</Text>
              </Pressable>
            ) : null}
          </View>
          <View style={columns === 2 ? styles.catalogGrid : styles.catalogStack}>
            {entries.slice(0, SECTION_SIZE).map((entry) => (
              <PluginRow
                key={entry.id}
                entry={entry}
                installed={installedSources.has(entry.installedSource)}
                columns={columns}
                onOpen={onOpenPlugin}
              />
            ))}
          </View>
        </View>
      ))}
    </>
  );
}

function PluginRow({
  entry,
  installed,
  columns,
  onOpen,
}: {
  entry: PluginMarketplaceEntry;
  installed: boolean;
  columns: number;
  onOpen: (params: PluginParams) => void;
}) {
  const styles = useThemedStyles(createIntegrationsStyles);
  const { t } = useI18n();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={entry.displayName}
      onPress={() => onOpen(pluginParams(entry))}
      style={({ pressed }) => [
        styles.row,
        columns === 2 ? styles.catalogCell : null,
        pressed && styles.pressed,
      ]}
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
      {installed ? <Text style={styles.secondary}>{t("Added")}</Text> : <Chevron />}
    </Pressable>
  );
}
