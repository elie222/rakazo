import type { ActionApprovalRule, ApprovalRulePreview, SettingsScope } from "@rakazo/contracts";
import { useState } from "react";
import { Text, TextInput, View } from "react-native";
import { useI18n } from "../lib/i18n";
import { useMobileTokens } from "../lib/native";
import type { settingsRpc } from "../lib/settings-target";
import { errorText } from "../lib/user-error";
import { NativeActionButton } from "./native-action-button";
import { NativeSegmentedControl } from "./native-segmented-control";

export function ApprovalRulePreviewForm({
  rule,
  scope,
  rpc,
}: {
  rule: ActionApprovalRule;
  scope: SettingsScope;
  rpc: ReturnType<typeof settingsRpc>;
}) {
  const { t } = useI18n();
  const tokens = useMobileTokens();
  const [tool, setTool] = useState(
    rule.matchKind === "tool" ? rule.matchValue : rule.matchKind === "site" ? "web_fetch" : "",
  );
  const [effect, setEffect] = useState<"always_allow" | "deny" | "remove">("remove");
  const [result, setResult] = useState<ApprovalRulePreview | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const label = (source: ApprovalRulePreview["before"]) =>
    source === "always_allow"
      ? t("Allow rule")
      : source === "deny"
        ? t("Block rule")
        : source === "require_approval"
          ? t("Ask rule")
          : t("No matching rule");
  async function preview() {
    if (pending || !tool.trim()) return;
    setPending(true);
    setResult(null);
    setError(null);
    try {
      setResult(
        await rpc("approvalRules/preview", {
          scope,
          id: rule.id,
          effect,
          sample: {
            tools: [
              {
                name: tool.trim(),
              },
            ],
            ...(rule.matchKind === "site" ? { site: rule.matchValue } : {}),
          },
        }),
      );
    } catch (err) {
      setError(errorText(err, t("Could not preview rule")));
    } finally {
      setPending(false);
    }
  }
  return (
    <View style={{ gap: 12, padding: 16 }}>
      <TextInput
        accessibilityLabel={t("Tool name")}
        placeholder={t("Tool name")}
        value={tool}
        autoCapitalize="none"
        autoCorrect={false}
        maxLength={200}
        editable={!pending}
        onChangeText={(value) => {
          setTool(value);
          setResult(null);
        }}
        style={{
          color: tokens.foreground,
          borderColor: tokens.border,
          borderWidth: 1,
          borderRadius: 8,
          padding: 12,
        }}
      />
      <NativeSegmentedControl
        accessibilityLabel={t("Candidate rule")}
        value={effect}
        disabled={pending}
        onChange={(value) => {
          setEffect(value);
          setResult(null);
        }}
        options={[
          ...(rule.matchKind !== "category"
            ? [
                { value: "always_allow" as const, label: t("Allow") },
                { value: "deny" as const, label: t("Block") },
              ]
            : []),
          { value: "remove", label: t("Remove") },
        ]}
      />
      <NativeActionButton
        label={t("Test rule")}
        disabled={pending || !tool.trim()}
        onPress={() => void preview()}
      />
      {result ? (
        <Text accessibilityLiveRegion="polite" style={{ color: tokens.foreground }}>
          {t("Current")}: {label(result.before)} → {t("Preview")}: {label(result.after)}
        </Text>
      ) : null}
      {error ? (
        <Text accessibilityRole="alert" style={{ color: tokens.destructive }}>
          {error}
        </Text>
      ) : null}
    </View>
  );
}
