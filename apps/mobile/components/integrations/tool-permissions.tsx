import { useLingui } from "@lingui/react/macro";
import type { AppPermissionTool, AppToolPermissionChange } from "@rakazo/core";
import {
  appToolLabel,
  appToolPermissionChoices,
  appToolPermissionReadsReady,
  appToolPermissionRequest,
  appToolRules,
  groupAppPermissionTools,
} from "@rakazo/core";
import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { errorText } from "../../lib/api/user-error";
import { useThemedStyles } from "../../lib/native/native";
import { rpcQuery, useSave } from "../../lib/query/query";
import { useScreenQuery } from "../../lib/query/screen-query";
import { MenuPicker } from "../ui/menu-picker";
import { Chevron } from "../ui/row-accessories";
import { createIntegrationsStyles } from "./integrations-styles";

export function ToolPermissions({ tools, slug }: { tools: AppPermissionTool[]; slug: string }) {
  const { t } = useLingui();
  const styles = useThemedStyles(createIntegrationsStyles);
  const [open, setOpen] = useState({ reads: false, other: false });
  const rulesRead = rpcQuery("approvalRules/list", {});
  const rulesQuery = useScreenQuery(rulesRead);
  const modeQuery = useScreenQuery(rpcQuery("autoReview/get", {}));
  const rules = appToolRules(rulesQuery.data ?? []);
  const change = useSave({
    save: async (selection: AppToolPermissionChange, send) => {
      const request = appToolPermissionRequest(selection, rules);
      if (request?.kind === "remove") await send("approvalRules/remove", request.input);
      if (request?.kind === "set") await send("approvalRules/set", request.input);
    },
    stale: [rulesRead.queryKey],
  });
  const loadError = rulesQuery.error ?? modeQuery.error;
  const disabled = !appToolPermissionReadsReady(rulesQuery, modeQuery) || change.pending;
  const mode = modeQuery.data?.mode;
  const labels = {
    default: t`Default`,
    always_allow: t`Allow`,
    require_approval: t`Ask`,
    deny: t`Block`,
  };
  const choices = appToolPermissionChoices(mode).map(({ permission, disabled }) => ({
    key: permission,
    label: labels[permission],
    disabled,
  }));
  const grouped = groupAppPermissionTools(tools);
  const titles = { reads: t`Reads`, other: t`Other actions` };
  const failure = change.error ?? loadError;

  return (
    <View style={styles.card}>
      <Text style={styles.section}>{t`Tool permissions`}</Text>
      {open.reads || open.other ? (
        <Text style={styles.secondary}>{t`Other approval rules still apply.`}</Text>
      ) : null}
      {mode === "never" ? (
        <Text style={styles.secondary}>{t`Only Block rules apply in Never ask.`}</Text>
      ) : null}
      {(["reads", "other"] as const).map((group) => {
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
