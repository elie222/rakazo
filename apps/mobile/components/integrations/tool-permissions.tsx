import { useLingui } from "@lingui/react/macro";
import type { AppPermissionTool, AppToolPermission } from "@rakazo/core";
import {
  approvalRuleApplies,
  appToolLabel,
  appToolRules,
  groupAppPermissionTools,
} from "@rakazo/core";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { errorText } from "../../lib/api/user-error";
import { useThemedStyles } from "../../lib/native/native";
import { rpcQuery, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";
import type { MenuPickerChoice } from "../ui/menu-picker";
import { MenuPicker } from "../ui/menu-picker";
import { Chevron } from "../ui/row-accessories";
import { createIntegrationsStyles } from "./integrations-styles";

type Change = { key: string; permission: AppToolPermission };

export function ToolPermissions({ tools, slug }: { tools: AppPermissionTool[]; slug: string }) {
  const { t } = useLingui();
  const styles = useThemedStyles(createIntegrationsStyles);
  const [open, setOpen] = useState({ reads: false, writes: false });
  const rulesRead = rpcQuery("approvalRules/list", {});
  const rulesQuery = useScreenQuery(rulesRead);
  const modeQuery = useScreenQuery(rpcQuery("autoReview/get", {}));
  const rules = appToolRules(rulesQuery.data ?? []);
  const change = useSave({
    save: async ({ key, permission }: Change, send) => {
      if (permission === "default") {
        const rule = rules.get(key.toLowerCase());
        if (rule) await send("approvalRules/remove", { id: rule.id });
      } else {
        await send("approvalRules/set", { effect: permission, matchKind: "tool", matchValue: key });
      }
    },
    stale: [rulesRead.queryKey],
  });
  const loadError = rulesQuery.error ?? modeQuery.error;
  const disabled =
    rulesQuery.isPending ||
    rulesQuery.isFetching ||
    modeQuery.isPending ||
    modeQuery.isFetching ||
    Boolean(loadError) ||
    change.pending;
  const mode = modeQuery.data?.mode;
  const choices: (MenuPickerChoice & { key: AppToolPermission })[] = [
    { key: "default", label: t`Default` },
    { key: "always_allow", label: t`Allow`, disabled: !approvalRuleApplies(mode, "always_allow") },
    {
      key: "require_approval",
      label: t`Ask`,
      disabled: !approvalRuleApplies(mode, "require_approval"),
    },
    { key: "deny", label: t`Block` },
  ];
  const grouped = groupAppPermissionTools(tools);
  const titles = { reads: t`Reads`, writes: t`Writes` };
  const failure = change.error ?? loadError;

  return (
    <View style={styles.card}>
      <Text style={styles.section}>{t`Tool permissions`}</Text>
      {mode === "never" ? (
        <Text style={styles.secondary}>{t`Only Block rules apply in Never ask.`}</Text>
      ) : null}
      {(["reads", "writes"] as const).map((group) => {
        if (!grouped[group].length) return null;
        return (
          <View key={group}>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: open[group] }}
              onPress={() => setOpen((current) => ({ ...current, [group]: !current[group] }))}
              style={styles.toolsToggle}
            >
              <Text style={styles.title}>{titles[group]}</Text>
              <Chevron expanded={open[group]} />
            </Pressable>
            {open[group] ? (
              <View style={styles.toolsBody}>
                {grouped[group].map((tool) => {
                  const key = tool.approvalKey;
                  const label = appToolLabel(tool.name, slug);
                  return (
                    <View key={key ?? tool.name} style={styles.toolsToggle}>
                      <View style={styles.toolSummary}>
                        <Text style={styles.toolName}>{label}</Text>
                        {tool.description !== tool.name && tool.description ? (
                          <Text numberOfLines={2} style={styles.secondary}>
                            {tool.description}
                          </Text>
                        ) : null}
                      </View>
                      {key ? (
                        <View style={styles.toolPicker}>
                          <MenuPicker
                            label={label}
                            choices={choices}
                            value={rules.get(key.toLowerCase())?.effect ?? "default"}
                            disabled={disabled}
                            plain
                            showLabel={false}
                            onChange={(value) => {
                              const choice = choices.find((entry) => entry.key === value);
                              if (choice && !choice.disabled)
                                change.run({ key, permission: choice.key });
                            }}
                          />
                        </View>
                      ) : null}
                    </View>
                  );
                })}
              </View>
            ) : null}
          </View>
        );
      })}
      {failure ? (
        <Text accessibilityRole="alert" style={styles.error}>
          {errorText(
            failure,
            change.error ? t`Could not save permission` : t`Could not load permissions`,
          )}
        </Text>
      ) : null}
    </View>
  );
}
