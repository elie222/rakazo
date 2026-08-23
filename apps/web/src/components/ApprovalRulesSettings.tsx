import type { ActionApprovalRule } from "@rakazo/contracts";
import { useEffect, useState } from "react";
import { rpc } from "../lib/rpc";

function describeRule(rule: ActionApprovalRule) {
  const target =
    rule.matchKind === "category"
      ? `${rule.matchValue} actions`
      : rule.matchKind === "connector"
        ? `${rule.matchValue} connector`
        : rule.matchValue;
  return rule.effect === "require_approval"
    ? `Ask before ${target}`
    : `Allow ${target} without asking`;
}

export function ApprovalRulesSettings() {
  const [rules, setRules] = useState<ActionApprovalRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [savingPreset, setSavingPreset] = useState<"email" | "purchase" | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setLoading(true);
    setError(null);
    try {
      setRules(await rpc.approvalRules.list());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load approval rules");
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
      setError(err instanceof Error ? err.message : "Could not save rule");
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
      setError(err instanceof Error ? err.message : "Could not remove rule");
    }
  }

  return (
    <div data-testid="action-confirmation-settings" className="pt-5">
      <h3 className="text-[15px] font-medium text-[#ECECEE]">Action confirmations</h3>
      <p className="mt-2 text-[13.5px] leading-[1.5] text-[#85858A]">
        Bots act without asking by default. Add an exception only when you want to review a type of
        action first. These preferences apply across all your bots.
      </p>
      <div className="mt-4 flex flex-col items-start gap-2">
        <button
          type="button"
          disabled={loading || savingPreset !== null}
          onClick={() => void setPreset("email")}
          className="rounded-[11px] border border-[#26262A] px-[17px] py-2 text-[14px] text-[#C9C9CE] disabled:opacity-50"
        >
          Ask before sending external email
        </button>
        <button
          type="button"
          disabled={loading || savingPreset !== null}
          onClick={() => void setPreset("purchase")}
          className="rounded-[11px] border border-[#26262A] px-[17px] py-2 text-[14px] text-[#C9C9CE] disabled:opacity-50"
        >
          Ask before purchases
        </button>
      </div>
      {error ? <p className="mt-3 text-[13px] text-[#E65707]">{error}</p> : null}
      {loading ? (
        <p className="mt-4 text-[13px] text-[#85858A]">Loading rules…</p>
      ) : rules.length === 0 ? (
        <p className="mt-4 text-[13px] text-[#85858A]">No exceptions. Actions run automatically.</p>
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
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
