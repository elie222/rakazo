import { useLingui } from "@lingui/react/macro";
import type { ActionApprovalRule, RpcOutput } from "@rakazo/contracts";
import { appToolLabel, connectorToolRequiresApproval } from "@rakazo/core";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { errorText } from "../../lib/api/user-error";
import { native, useThemedStyles } from "../../lib/native/native";
import { rpcQuery, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";
import { NativeSymbol } from "../native/native-symbol";
import type { MenuPickerChoice } from "../ui/menu-picker";
import { MenuPickerMenu } from "../ui/menu-picker";
import { Chevron } from "../ui/row-accessories";
import { createIntegrationsStyles } from "./integrations-styles";

type Tool = RpcOutput<"connections/tools">[number];
/** A tool's own rule, or none: whatever the approval mode does for its kind. */
type Permission = ActionApprovalRule["effect"] | "default";

/** An app's tools split into what only looks and what changes something, each with its rule. */
export function ToolPermissions({ tools, slug }: { tools: Tool[]; slug: string }) {
  const { t } = useLingui();
  const styles = useThemedStyles(createIntegrationsStyles);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  // No scope: the copy of the rules that applies here, the Space's when it customizes them.
  const rulesRead = rpcQuery("approvalRules/list", {});
  const rulesQuery = useScreenQuery(rulesRead, { onForeground: false });
  const toolRules = new Map(
    (rulesQuery.data ?? [])
      .filter((rule) => rule.matchKind === "tool")
      .map((rule) => [rule.matchValue.toLowerCase(), rule]),
  );
  const permissionOf = (tool: Tool): Permission =>
    toolRules.get(tool.name.toLowerCase())?.effect ?? "default";
  const change = useSave({
    save: async ({ tools, permission }: { tools: Tool[]; permission: Permission }, send) => {
      await Promise.all(
        tools.map((tool) => {
          const rule = toolRules.get(tool.name.toLowerCase());
          if (permission === "default") {
            return rule ? send("approvalRules/remove", { id: rule.id }) : undefined;
          }
          if (rule?.effect === permission) return undefined;
          return send("approvalRules/set", {
            effect: permission,
            matchKind: "tool",
            matchValue: tool.name,
          });
        }),
      );
    },
    stale: [rulesRead.queryKey],
  });
  const disabled = rulesQuery.isPending || Boolean(rulesQuery.error) || change.pending;
  const failure = change.error ?? rulesQuery.error;
  const choices: Array<MenuPickerChoice & { key: Permission }> = [
    { key: "default", label: t`Default` },
    { key: "always_allow", label: t`Allow` },
    { key: "require_approval", label: t`Ask` },
    { key: "deny", label: t`Block` },
  ];
  const writes = tools.filter((tool) => connectorToolRequiresApproval(tool.name, tool.readOnly));
  const reads = tools.filter((tool) => !writes.includes(tool));
  const groups = [
    { key: "reads", title: t`Reads`, tools: reads },
    { key: "writes", title: t`Writes`, tools: writes },
  ].filter((group) => group.tools.length > 0);

  const picker = (label: string, value: string, groupTools: Tool[]) => (
    <View style={{ width: 96 }}>
      <MenuPickerMenu
        label={label}
        choices={choices}
        value={value}
        disabled={disabled}
        onChange={(key) => {
          const choice = choices.find((entry) => entry.key === key);
          if (choice) change.run({ tools: groupTools, permission: choice.key });
        }}
      >
        <View
          accessible
          accessibilityRole="button"
          accessibilityLabel={label}
          accessibilityValue={{
            text: choices.find((choice) => choice.key === value)?.label ?? "",
          }}
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 4,
            opacity: disabled ? 0.5 : 1,
          }}
        >
          <Text numberOfLines={1} style={styles.secondary}>
            {choices.find((choice) => choice.key === value)?.label ?? t`Mixed`}
          </Text>
          <NativeSymbol
            android="chevron-expand"
            color={native.tertiaryLabel}
            ios="chevron.up.chevron.down"
            size={11}
          />
        </View>
      </MenuPickerMenu>
    </View>
  );

  return (
    <View style={styles.card}>
      <Text style={styles.section}>{t`Tool permissions`}</Text>
      {groups.map((group) => {
        const shared = new Set(group.tools.map(permissionOf));
        const value = shared.size === 1 ? ([...shared][0] ?? "") : "";
        const expanded = open[group.key] ?? false;
        return (
          <View key={group.key} style={{ gap: 8 }}>
            <View style={styles.toolsToggle}>
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                onPress={() => setOpen((now) => ({ ...now, [group.key]: !expanded }))}
                style={{ flex: 1, flexDirection: "row", alignItems: "center", gap: 6 }}
              >
                <Text style={styles.title}>{group.title}</Text>
                <Text style={styles.secondary}>{group.tools.length}</Text>
                <Chevron expanded={expanded} />
              </Pressable>
              {picker(t`${group.title} permission`, value, group.tools)}
            </View>
            {expanded ? (
              <View style={styles.toolsBody}>
                {group.tools.map((tool) => {
                  const label = appToolLabel(tool.name, slug);
                  return (
                    <View key={tool.name} style={styles.toolsToggle}>
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <Text numberOfLines={1} style={styles.toolName}>
                          {label}
                        </Text>
                        {tool.description && tool.description !== tool.name ? (
                          <Text numberOfLines={1} style={styles.secondary}>
                            {tool.description}
                          </Text>
                        ) : null}
                      </View>
                      {picker(label, permissionOf(tool), [tool])}
                    </View>
                  );
                })}
              </View>
            ) : null}
          </View>
        );
      })}
      {failure ? <Text style={styles.error}>{errorText(failure)}</Text> : null}
    </View>
  );
}
