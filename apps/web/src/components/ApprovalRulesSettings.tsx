import { Trans, useLingui } from "@lingui/react/macro";
import type {
  ActionApprovalRule,
  ActionAutoReviewSettings,
  ApprovalMode,
  SettingsScope,
} from "@rakazo/contracts";
import { humanizeToolName } from "@rakazo/core";
import { writeSaved } from "@rakazo/core/query";
import { Button, Input, ToggleGroup, ToggleGroupItem } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useState } from "react";
import { useSpaceQueries } from "../lib/query";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

const segmented = "rounded-lg bg-muted p-1";
const segment = "h-7 px-3 text-[13px] aria-pressed:bg-background aria-pressed:shadow-sm";

/** Approvals for the account, or for the bound Space when it customizes them. */
export function ApprovalRulesSettings({ scope }: { scope: SettingsScope }) {
  const rpc = useSpaceRpc();
  const { t } = useLingui();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const input = { scope };
  const rulesQuery = useQuery(queries.approvalRules.list.queryOptions({ input }));
  const autoReviewQuery = useQuery(queries.autoReview.get.queryOptions({ input }));
  const rules = rulesQuery.data ?? [];
  const autoReview = autoReviewQuery.data ?? null;
  const loading = rulesQuery.isPending || autoReviewQuery.isPending;
  const loadFailed = rulesQuery.error ?? autoReviewQuery.error;
  const [adding, setAdding] = useState(false);
  const [tool, setTool] = useState("");
  const [saving, setSaving] = useState(false);
  const [actionError, setError] = useState<string | null>(null);
  const error =
    actionError ?? (loadFailed ? errorText(loadFailed, t`Could not load approval rules`) : null);
  const modes: Array<{ mode: ApprovalMode; label: string }> = [
    { mode: "never", label: t`Never ask` },
    // Auto needs an approval model; it stays listed while chosen so the choice is visible.
    ...(autoReview?.checkerAvailable || autoReview?.mode === "auto"
      ? [{ mode: "auto" as const, label: t`Auto` }]
      : []),
    { mode: "ask", label: t`Ask` },
  ];

  function setRules(update: (current: ActionApprovalRule[]) => ActionApprovalRule[]) {
    return writeSaved(queryClient, queries.approvalRules.list.queryKey({ input }), (current) =>
      update(current ?? []),
    );
  }

  function setAutoReview(next: ActionAutoReviewSettings) {
    return writeSaved(queryClient, queries.autoReview.get.queryKey({ input }), () => next);
  }

  async function save(work: () => Promise<unknown>, failure: string) {
    if (saving) return;
    setSaving(true);
    setError(null);
    try {
      await work();
    } catch (err) {
      setError(errorText(err, failure));
    } finally {
      setSaving(false);
    }
  }

  const setMode = (mode: ApprovalMode) =>
    save(
      async () => setAutoReview(await rpc.autoReview.set({ scope, mode })),
      t`Could not save Auto Review`,
    );

  const setEffect = (
    rule: ActionApprovalRule,
    effect: "always_allow" | "require_approval" | "deny",
  ) =>
    save(async () => {
      if (rule.matchKind === "category") return;
      const saved = await rpc.approvalRules.set({
        scope,
        effect,
        matchKind: rule.matchKind,
        matchValue: rule.matchValue,
      });
      // Saving replaces the rule's other effect on the same match.
      await setRules((current) => [...current.filter((other) => other.id !== rule.id), saved]);
    }, t`Could not save rule`);

  const removeRule = (rule: ActionApprovalRule) =>
    save(async () => {
      await rpc.approvalRules.remove({ scope, id: rule.id });
      await setRules((current) => current.filter((other) => other.id !== rule.id));
    }, t`Could not remove rule`);

  return (
    <div data-testid="approval-settings" className="space-y-8">
      <SettingsGroup>
        <SettingsRow
          label={<Trans>Mode</Trans>}
          control={
            <ToggleGroup
              aria-label={t`Mode`}
              data-testid="approval-mode"
              value={autoReview ? [autoReview.mode] : []}
              onValueChange={([next]) => {
                if (next && next !== autoReview?.mode) void setMode(next as ApprovalMode);
              }}
              disabled={loading || saving || !autoReview}
              spacing={1}
              className={segmented}
            >
              {modes.map(({ mode, label }) => (
                <ToggleGroupItem key={mode} value={mode} className={segment}>
                  {label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
          }
        >
          {autoReview?.mode === "auto" && !autoReview.checkerAvailable ? (
            <p className="mt-1 text-[13px] text-muted-foreground">
              <Trans>Add a model in Settings to use this.</Trans>
            </p>
          ) : null}
        </SettingsRow>
      </SettingsGroup>
      <Button
        variant="outline"
        size="sm"
        disabled={loading || Boolean(loadFailed) || saving}
        onClick={() => setAdding(!adding)}
        aria-expanded={adding}
      >
        <Trans>Add rule</Trans>
      </Button>
      {adding ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (!tool.trim()) return;
            void save(async () => {
              const saved = await rpc.approvalRules.set({
                scope,
                matchKind: "tool",
                matchValue: tool.trim(),
                effect: "require_approval",
              });
              await setRules((current) => [
                ...current.filter(
                  (rule) =>
                    rule.matchKind !== saved.matchKind ||
                    rule.matchValue.toLowerCase() !== saved.matchValue.toLowerCase(),
                ),
                saved,
              ]);
              setTool("");
              setAdding(false);
            }, t`Could not save rule`);
          }}
        >
          <Input
            aria-label={t`Tool name`}
            placeholder={t`Tool name`}
            value={tool}
            maxLength={200}
            disabled={saving}
            onChange={(event) => setTool(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={saving || !tool.trim()}>
            <Trans>Save</Trans>
          </Button>
        </form>
      ) : null}
      {rules.length > 0 ? (
        <SettingsGroup title={<Trans>Rules</Trans>} data-testid="approval-rules">
          {rules.map((rule) => (
            <SettingsRow
              key={rule.id}
              label={ruleLabel(rule)}
              control={
                <>
                  {rule.matchKind === "category" ? (
                    <span className="text-[13px] text-muted-foreground">
                      {rule.effect === "always_allow" ? (
                        <Trans>Allow</Trans>
                      ) : rule.effect === "deny" ? (
                        <Trans>Block</Trans>
                      ) : (
                        <Trans>Ask</Trans>
                      )}
                    </span>
                  ) : (
                    <ToggleGroup
                      aria-label={ruleLabel(rule)}
                      value={[rule.effect]}
                      onValueChange={([next]) => {
                        if (
                          next === "always_allow" ||
                          next === "require_approval" ||
                          next === "deny"
                        )
                          void setEffect(rule, next);
                      }}
                      disabled={saving}
                      spacing={1}
                      className={segmented}
                    >
                      <ToggleGroupItem value="always_allow" className={segment}>
                        <Trans>Allow</Trans>
                      </ToggleGroupItem>
                      <ToggleGroupItem value="require_approval" className={segment}>
                        <Trans>Ask</Trans>
                      </ToggleGroupItem>
                      <ToggleGroupItem value="deny" className={segment}>
                        <Trans>Block</Trans>
                      </ToggleGroupItem>
                    </ToggleGroup>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t`Remove`}
                    className="text-destructive hover:text-destructive"
                    disabled={saving}
                    onClick={() => void removeRule(rule)}
                  >
                    <Trash2 />
                  </Button>
                </>
              }
            />
          ))}
        </SettingsGroup>
      ) : null}
      {error ? <p className="text-[13px] text-destructive">{error}</p> : null}
    </div>
  );
}

/** A site reads as itself; a tool, connector or older category by its name. */
function ruleLabel(rule: ActionApprovalRule): string {
  return rule.matchKind === "site" ? rule.matchValue : humanizeToolName(rule.matchValue);
}
