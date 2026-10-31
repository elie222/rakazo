import { expect, it } from "vitest";
import type { ActionApprovalRule } from "./action-approval.js";
import { previewActionApprovalRule, resolveActionApprovalForTools } from "./action-approval.js";

const allow: ActionApprovalRule = {
  effect: "always_allow",
  matchKind: "tool",
  matchValue: "gmail_send_email",
};
const sample = { tools: [{ name: "gmail_send_email" }] };

it("matches live resolution without changing the saved rules", () => {
  const rules = [allow];
  const before = structuredClone(rules);
  for (const effect of ["always_allow", "require_approval", "deny", "remove"] as const) {
    const expected = effect === "remove" ? [] : [{ ...allow, effect }];
    expect(previewActionApprovalRule(rules, allow, effect, sample)).toEqual({
      before: resolveActionApprovalForTools({ ...sample, rules }).source,
      after: resolveActionApprovalForTools({ ...sample, rules: expected }).source,
    });
  }
  expect(rules).toEqual(before);
});

it("does not let a candidate allow override a broader block", () => {
  const deny: ActionApprovalRule = { effect: "deny", matchKind: "connector", matchValue: "gmail" };
  expect(previewActionApprovalRule([allow, deny], allow, "always_allow", sample)).toEqual({
    before: "deny",
    after: "deny",
  });
});

it("matches the longest connector prefix without attributing unrelated tools to it", () => {
  const connector: ActionApprovalRule = {
    effect: "deny",
    matchKind: "connector",
    matchValue: "microsoft_outlook",
  };
  expect(
    previewActionApprovalRule([connector], connector, "remove", {
      tools: [{ name: "MICROSOFT_OUTLOOK_SEND_EMAIL" }],
    }),
  ).toEqual({ before: "deny", after: "default" });
  expect(
    previewActionApprovalRule([connector], connector, "always_allow", {
      tools: [{ name: "slack_post_message" }],
    }),
  ).toEqual({ before: "default", after: "default" });
});

it("replaces matching effects case-insensitively but removes only the selected rule", () => {
  const other: ActionApprovalRule = {
    ...allow,
    effect: "require_approval",
    matchValue: "GMAIL_SEND_EMAIL",
  };
  expect(previewActionApprovalRule([allow, other], allow, "deny", sample).after).toBe("deny");
  expect(previewActionApprovalRule([allow, other], allow, "remove", sample).after).toBe(
    "require_approval",
  );
});

it("keeps unruled actions distinct from an allow rule and respects every batch action", () => {
  const batch = {
    tools: [{ name: "gmail_send_email" }, { name: "slack_post_message" }],
    wrapper: { name: "COMPOSIO_MULTI_EXECUTE_TOOL" },
  };
  expect(previewActionApprovalRule([allow], allow, "always_allow", batch)).toEqual({
    before: "default",
    after: "default",
  });
  expect(previewActionApprovalRule([allow], allow, "deny", batch).after).toBe("deny");
});

it("uses declared writes and site matching from the shared evaluator", () => {
  const category: ActionApprovalRule = {
    effect: "deny",
    matchKind: "category",
    matchValue: "email",
  };
  const read = { tools: [{ name: "gmail_get_message", readOnly: false }] };
  expect(previewActionApprovalRule([category], category, "remove", read)).toEqual({
    before: "deny",
    after: "default",
  });
  const site: ActionApprovalRule = {
    effect: "always_allow",
    matchKind: "site",
    matchValue: "example.test",
  };
  expect(
    previewActionApprovalRule([site], site, "remove", {
      tools: [{ name: "web_fetch" }],
      site: "example.test",
    }),
  ).toEqual({ before: "always_allow", after: "default" });
});
