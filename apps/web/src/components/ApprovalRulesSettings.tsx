import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ActionApprovalRule, ActionAutoReviewSettings } from "@rakazo/contracts";
import { Button, Label, Spinner, Switch } from "@rakazo/ui-web";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useId, useState } from "react";
import { useSpaceQueries, writeSaved } from "../lib/query";
import { useSpaceRpc } from "../lib/space-rpc";
import { errorText } from "../lib/user-error";

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

export function ApprovalRulesSettings() {
  const rpc = useSpaceRpc();
  const { t } = useLingui();
  const autoReviewId = useId();
  const skipApprovalsId = useId();
  const queries = useSpaceQueries();
  const queryClient = useQueryClient();
  const rulesQuery = useQuery(queries.approvalRules.list.queryOptions());
  const autoReviewQuery = useQuery(queries.autoReview.get.queryOptions());
  const rules = rulesQuery.data ?? [];
  const autoReview = autoReviewQuery.data ?? null;
  const loading = rulesQuery.isPending || autoReviewQuery.isPending;
  const loadFailed = rulesQuery.error ?? autoReviewQuery.error;
  const [savingPreset, setSavingPreset] = useState<"email" | "purchase" | null>(null);
  const [savingAutoReview, setSavingAutoReview] = useState(false);
  const [actionError, setError] = useState<string | null>(null);
  const error =
    actionError ?? (loadFailed ? errorText(loadFailed, t`Could not load approval rules`) : null);

  function setRules(update: (current: ActionApprovalRule[]) => ActionApprovalRule[]) {
    return writeSaved(queryClient, queries.approvalRules.list.queryKey(), (current) =>
      update(current ?? []),
    );
  }

  function setAutoReview(next: ActionAutoReviewSettings) {
    return writeSaved(queryClient, queries.autoReview.get.queryKey(), () => next);
  }

  async function setPreset(matchValue: "email" | "purchase") {
    if (loading || savingPreset) return;
    if (
      rules.some(
        (rule) =>
          rule.effect === "require_approval" &&
          rule.matchKind === "category" &&
          rule.matchValue === matchValue,
      )
    ) {
      return;
    }
    setSavingPreset(matchValue);
    setError(null);
    try {
      const saved = await rpc.approvalRules.set({
        effect: "require_approval",
        matchKind: "category",
        matchValue,
      });
      await setRules((current) => [...current, saved]);
    } catch (err) {
      setError(errorText(err, t`Could not save rule`));
    } finally {
      setSavingPreset(null);
    }
  }

  async function removeRule(id: string) {
    setError(null);
    try {
      await rpc.approvalRules.remove({ id });
      await setRules((current) => current.filter((rule) => rule.id !== id));
    } catch (err) {
      setError(errorText(err, t`Could not remove rule`));
    }
  }

  async function saveAutoReview(input: { enabled?: boolean; skipApprovals?: boolean }) {
    if (loading || savingAutoReview) return;
    setSavingAutoReview(true);
    setError(null);
    try {
      await setAutoReview(await rpc.autoReview.set(input));
    } catch (err) {
      setError(errorText(err, t`Could not save Auto Review`));
    } finally {
      setSavingAutoReview(false);
    }
  }

  return (
    <div data-testid="action-confirmation-settings" className="pt-5">
      <div className="mb-5 flex items-center gap-3">
        <Switch
          id={skipApprovalsId}
          data-testid="skip-approvals-toggle"
          checked={autoReview?.skipApprovals ?? false}
          disabled={loading || savingAutoReview || !autoReview}
          onCheckedChange={(checked) => void saveAutoReview({ skipApprovals: checked })}
        />
        <Label htmlFor={skipApprovalsId} className="text-[14px] font-normal text-foreground/75">
          <Trans>Run actions without asking</Trans>
        </Label>
      </div>
      <div className="flex flex-col items-start gap-2">
        <Button
          variant="outline"
          disabled={loading || savingPreset !== null}
          onClick={() => void setPreset("email")}
        >
          <Trans>Ask before sending external email</Trans>
        </Button>
        <Button
          variant="outline"
          disabled={loading || savingPreset !== null}
          onClick={() => void setPreset("purchase")}
        >
          <Trans>Ask before purchases</Trans>
        </Button>
      </div>
      {autoReview?.skipApprovals ? null : (
        <div className="mt-5 flex items-start gap-3">
          <Switch
            id={autoReviewId}
            data-testid="auto-review-toggle"
            className="mt-0.5"
            checked={autoReview?.enabled ?? false}
            disabled={loading || savingAutoReview || !autoReview}
            onCheckedChange={(checked) => void saveAutoReview({ enabled: checked })}
          />
          <div>
            <Label htmlFor={autoReviewId} className="text-[14px] font-normal text-foreground/75">
              <Trans>Flag unexpected actions</Trans>
            </Label>
            {autoReview?.enabled && !autoReview.checkerAvailable ? (
              <p className="mt-1 text-[13px] text-muted-foreground">
                <Trans>Add a model in Settings to use this.</Trans>
              </p>
            ) : null}
          </div>
        </div>
      )}
      {error ? <p className="mt-3 text-[13px] text-destructive">{error}</p> : null}
      {loading ? (
        <p className="mt-4 text-[13px] text-muted-foreground">
          <Spinner aria-label={t`Loading rules…`} />
        </p>
      ) : rules.length > 0 ? (
        <ul className="mt-4 space-y-2">
          {rules.map((rule) => (
            <li
              key={rule.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-border px-3.5 py-2"
            >
              <span className="text-[13.5px] text-foreground/75">{describeRule(rule)}</span>
              <Button
                variant="ghost"
                size="sm"
                className="text-muted-foreground"
                onClick={() => void removeRule(rule.id)}
              >
                <Trans>Remove</Trans>
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
