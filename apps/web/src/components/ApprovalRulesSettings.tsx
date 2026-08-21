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
    setError(null);
    try {
      await rpc.approvalRules.set({
        effect: "require_approval",
        matchKind: "category",
        matchValue,
      });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save rule");
    }
  }

  async function removeRule(id: string) {
    setError(null);
    try {
      await rpc.approvalRules.remove({ id });
      await refresh();
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
          onClick={() => void setPreset("email")}
          className="rounded-[11px] border border-[#26262A] px-[17px] py-2 text-[14px] text-[#C9C9CE]"
        >
          Ask before sending external email
        </button>
        <button
          type="button"
          onClick={() => void setPreset("purchase")}
          className="rounded-[11px] border border-[#26262A] px-[17px] py-2 text-[14px] text-[#C9C9CE]"
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
