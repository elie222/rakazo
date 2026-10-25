import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type {
  ActionApprovalRule,
  ActionAutoReviewSettings,
  SettingsScope,
} from "@rakazo/contracts";
import { Button, Label, Switch } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useSpaceQueries, writeSaved } from "../lib/query";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";
import { SettingsGroup, SettingsRow } from "./SettingsRows";

type Preset = "email" | "purchase";

function describeRule(rule: ActionApprovalRule): string {
  if (rule.effect === "require_approval") {
    if (rule.matchKind === "category") {
      if (rule.matchValue === "email") return t`Ask before email actions`;
      if (rule.matchValue === "purchase") return t`Ask before purchase actions`;
      return t`Ask before ${rule.matchValue} actions`;
    }
    if (rule.matchKind === "connector") return t`Ask before ${rule.matchValue} connector`;
    return t`Ask before ${rule.matchValue}`;
  }
  if (rule.matchKind === "category") {
    if (rule.matchValue === "email") return t`Allow email actions without asking`;
    if (rule.matchValue === "purchase") return t`Allow purchase actions without asking`;
    return t`Allow ${rule.matchValue} actions without asking`;
  }
  if (rule.matchKind === "connector") return t`Allow ${rule.matchValue} connector without asking`;
  return t`Allow ${rule.matchValue} without asking`;
}

/** Confirmations for the account, or for the bound Space when it overrides them. */
export function ApprovalRulesSettings({ scope }: { scope: SettingsScope }) {
  const rpc = useSpaceRpc();
  const { t } = useLingui();
  const autoReviewId = useId();
  const skipApprovalsId = useId();
  const emailPresetId = useId();
  const purchasePresetId = useId();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const input = { scope };
  const rulesQuery = useQuery(queries.approvalRules.list.queryOptions({ input }));
  const autoReviewQuery = useQuery(queries.autoReview.get.queryOptions({ input }));
  const rules = rulesQuery.data ?? [];
  const autoReview = autoReviewQuery.data ?? null;
  const loading = rulesQuery.isPending || autoReviewQuery.isPending;
  const loadFailed = rulesQuery.error ?? autoReviewQuery.error;
  const [savingPreset, setSavingPreset] = useState<Preset | null>(null);
  const [savingAutoReview, setSavingAutoReview] = useState(false);
  const [actionError, setError] = useState<string | null>(null);
  const error =
    actionError ?? (loadFailed ? errorText(loadFailed, t`Could not load approval rules`) : null);
  const presetRule = (preset: Preset) =>
    rules.find(
      (rule) =>
        rule.effect === "require_approval" &&
        rule.matchKind === "category" &&
        rule.matchValue === preset,
    );
  const otherRules = rules.filter(
    (rule) => rule !== presetRule("email") && rule !== presetRule("purchase"),
  );

  function setRules(update: (current: ActionApprovalRule[]) => ActionApprovalRule[]) {
    return writeSaved(queryClient, queries.approvalRules.list.queryKey({ input }), (current) =>
      update(current ?? []),
    );
  }

  function setAutoReview(next: ActionAutoReviewSettings) {
    return writeSaved(queryClient, queries.autoReview.get.queryKey({ input }), () => next);
  }

  async function setPreset(preset: Preset, on: boolean) {
    if (loading || savingPreset) return;
    const existing = presetRule(preset);
    if (on === Boolean(existing)) return;
    setSavingPreset(preset);
    setError(null);
    try {
      if (existing) {
        await rpc.approvalRules.remove({ scope, id: existing.id });
        await setRules((current) => current.filter((rule) => rule.id !== existing.id));
      } else {
        const saved = await rpc.approvalRules.set({
          scope,
          effect: "require_approval",
          matchKind: "category",
          matchValue: preset,
        });
        await setRules((current) => [...current, saved]);
      }
    } catch (err) {
      setError(errorText(err, t`Could not save rule`));
    } finally {
      setSavingPreset(null);
    }
  }

  async function removeRule(id: string) {
    setError(null);
    try {
      await rpc.approvalRules.remove({ scope, id });
      await setRules((current) => current.filter((rule) => rule.id !== id));
    } catch (err) {
      setError(errorText(err, t`Could not remove rule`));
    }
  }

  async function saveAutoReview(change: { enabled?: boolean; skipApprovals?: boolean }) {
    if (loading || savingAutoReview) return;
    setSavingAutoReview(true);
    setError(null);
    try {
      await setAutoReview(await rpc.autoReview.set({ ...change, scope }));
    } catch (err) {
      setError(errorText(err, t`Could not save Auto Review`));
    } finally {
      setSavingAutoReview(false);
    }
  }

  return (
    <div data-testid="action-confirmation-settings" className="space-y-8">
      <SettingsGroup>
        <SettingsRow
          label={
            <Label htmlFor={skipApprovalsId} className="text-[14px] font-normal text-foreground">
              <Trans>Run actions without asking</Trans>
            </Label>
          }
          control={
            <Switch
              id={skipApprovalsId}
              data-testid="skip-approvals-toggle"
              checked={autoReview?.skipApprovals ?? false}
              disabled={loading || savingAutoReview || !autoReview}
              onCheckedChange={(checked) => void saveAutoReview({ skipApprovals: checked })}
            />
          }
        />
        {autoReview?.skipApprovals ? null : (
          <SettingsRow
            label={
              <Label htmlFor={autoReviewId} className="text-[14px] font-normal text-foreground">
                <Trans>Flag unexpected actions</Trans>
              </Label>
            }
            control={
              <Switch
                id={autoReviewId}
                data-testid="auto-review-toggle"
                checked={autoReview?.enabled ?? false}
                disabled={loading || savingAutoReview || !autoReview}
                onCheckedChange={(checked) => void saveAutoReview({ enabled: checked })}
              />
            }
          >
            {autoReview?.enabled && !autoReview.checkerAvailable ? (
              <p className="mt-1 text-[13px] text-muted-foreground">
                <Trans>Add a model in Settings to use this.</Trans>
              </p>
            ) : null}
          </SettingsRow>
        )}
        <SettingsRow
          label={
            <Label htmlFor={emailPresetId} className="text-[14px] font-normal text-foreground">
              <Trans>Ask before sending external email</Trans>
            </Label>
          }
          control={
            <Switch
              id={emailPresetId}
              data-testid="ask-before-email-toggle"
              checked={Boolean(presetRule("email"))}
              disabled={loading || savingPreset !== null}
              onCheckedChange={(checked) => void setPreset("email", checked)}
            />
          }
        />
        <SettingsRow
          label={
            <Label htmlFor={purchasePresetId} className="text-[14px] font-normal text-foreground">
              <Trans>Ask before purchases</Trans>
            </Label>
          }
          control={
            <Switch
              id={purchasePresetId}
              data-testid="ask-before-purchase-toggle"
              checked={Boolean(presetRule("purchase"))}
              disabled={loading || savingPreset !== null}
              onCheckedChange={(checked) => void setPreset("purchase", checked)}
            />
          }
        />
      </SettingsGroup>
      {otherRules.length > 0 ? (
        <SettingsGroup>
          {otherRules.map((rule) => (
            <SettingsRow
              key={rule.id}
              label={describeRule(rule)}
              control={
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-muted-foreground"
                  onClick={() => void removeRule(rule.id)}
                >
                  <Trans>Remove</Trans>
                </Button>
              }
            />
          ))}
        </SettingsGroup>
      ) : null}
      {error ? <p className="text-[13px] text-destructive">{error}</p> : null}
    </div>
  );
}
