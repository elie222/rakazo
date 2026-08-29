import { t } from "@lingui/core/macro";
import { Trans, useLingui } from "@lingui/react/macro";
import type { ActionApprovalRule, ActionAutoReviewSettings } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

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
  const { t } = useLingui();
  const [rules, setRules] = useState<ActionApprovalRule[]>([]);
  const [autoReview, setAutoReview] = useState<ActionAutoReviewSettings | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingPreset, setSavingPreset] = useState<"email" | "purchase" | null>(null);
  const [savingAutoReview, setSavingAutoReview] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      const [nextRules, nextAutoReview] = await Promise.all([
        rpc.approvalRules.list(),
        rpc.autoReview.get(),
      ]);
      setRules(nextRules);
      setAutoReview(nextAutoReview);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not load approval rules`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
  }, []);

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
      setRules((current) => [...current, saved]);
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not save rule`);
    } finally {
      setSavingPreset(null);
    }
  }

  async function removeRule(id: string) {
    setError(null);
    try {
      await rpc.approvalRules.remove({ id });
      setRules((current) => current.filter((rule) => rule.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not remove rule`);
    }
  }

  async function toggleAutoReview(enabled: boolean) {
    if (loading || savingAutoReview) return;
    setSavingAutoReview(true);
    setError(null);
    try {
      setAutoReview(await rpc.autoReview.set({ enabled }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t`Could not save Auto Review`);
    } finally {
      setSavingAutoReview(false);
    }
  }

  return (
    <div data-testid="action-confirmation-settings" className="pt-5">
      <h3 className="text-[15px] font-medium text-[#ECECEE]">
        <Trans>Action confirmations</Trans>
      </h3>
      <p className="mt-2 text-[13.5px] leading-[1.5] text-[#85858A]">
        <Trans>
          Bots act without asking by default. Add an exception only when you want to review a type
          of action first. These preferences apply across all your bots.
        </Trans>
      </p>
      <div className="mt-4 flex flex-col items-start gap-2">
        <button
          type="button"
          disabled={loading || savingPreset !== null}
          onClick={() => void setPreset("email")}
          className="rounded-[11px] border border-[#26262A] px-[17px] py-2 text-[14px] text-[#C9C9CE] disabled:opacity-50"
        >
          <Trans>Ask before sending external email</Trans>
        </button>
        <button
          type="button"
          disabled={loading || savingPreset !== null}
          onClick={() => void setPreset("purchase")}
          className="rounded-[11px] border border-[#26262A] px-[17px] py-2 text-[14px] text-[#C9C9CE] disabled:opacity-50"
        >
          <Trans>Ask before purchases</Trans>
        </button>
      </div>
      <label className="mt-5 flex cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          data-testid="auto-review-toggle"
          className="mt-1"
          checked={autoReview?.enabled ?? false}
          disabled={loading || savingAutoReview || !autoReview}
          onChange={(event) => void toggleAutoReview(event.target.checked)}
        />
        <span>
          <span className="block text-[14px] text-[#C9C9CE]">
            <Trans>Flag unexpected actions</Trans>
          </span>
          {autoReview?.enabled && !autoReview.checkerAvailable ? (
            <span className="mt-1 block text-[13px] text-[#85858A]">
              <Trans>Add a model in Settings to use this.</Trans>
            </span>
          ) : null}
        </span>
      </label>
      {error ? <p className="mt-3 text-[13px] text-[#E65707]">{error}</p> : null}
      {loading ? (
        <p className="mt-4 text-[13px] text-[#85858A]">
          <Trans>Loading rules…</Trans>
        </p>
      ) : rules.length === 0 ? (
        <p className="mt-4 text-[13px] text-[#85858A]">
          <Trans>No exceptions. Actions run automatically.</Trans>
        </p>
      ) : (
        <ul className="mt-4 space-y-2">
          {rules.map((rule) => (
            <li
              key={rule.id}
              className="flex items-center justify-between gap-3 rounded-[11px] border border-[#26262A] px-3.5 py-2.5"
            >
              <span className="text-[13.5px] text-[#C9C9CE]">{describeRule(rule)}</span>
              <button
                type="button"
                onClick={() => void removeRule(rule.id)}
                className="text-[13px] text-[#85858A]"
              >
                <Trans>Remove</Trans>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
