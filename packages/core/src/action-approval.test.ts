import { describe, expect, it } from "vitest";
import {
  type ActionApprovalRule,
  applyJudgeDecision,
  connectorKindFromToolName,
  connectorToolRequiresApproval,
  isApprovalAskBlock,
  isSecretAskBlock,
  planActionGate,
  resolveActionApproval,
  resolveActionApprovalDetail,
  toolRequiresApproval,
} from "./action-approval.js";

describe("toolRequiresApproval", () => {
  it("requires approval for consequential builtins and destination writes", () => {
    expect(toolRequiresApproval("destination.write", false)).toBe(true);
    expect(toolRequiresApproval("destination.write", true)).toBe(true);
    expect(toolRequiresApproval("delete_bot", false)).toBe(true);
    expect(toolRequiresApproval("archive_bot", false)).toBe(true);
  });

  it("does not gate read-only or local work", () => {
    for (const name of [
      "list_files",
      "computer_observe",
      "read_file",
      "write_file",
      "shell",
      "remember",
      "spawn_bot",
      "run_subagent",
    ]) {
      expect(toolRequiresApproval(name, false)).toBe(false);
    }
  });

  it("gates connector executes except obvious reads", () => {
    expect(toolRequiresApproval("gmail_send_email", true)).toBe(true);
    expect(toolRequiresApproval("crm_create_note", true)).toBe(true);
    expect(toolRequiresApproval("get_contact", true)).toBe(false);
    expect(toolRequiresApproval("contacts_get", true)).toBe(false);
    expect(toolRequiresApproval("GMAIL_LIST_THREADS", true)).toBe(false);
    expect(toolRequiresApproval("list_messages", true)).toBe(false);
    expect(toolRequiresApproval("search_threads", true)).toBe(false);
    expect(toolRequiresApproval("find_user", true)).toBe(false);
    expect(toolRequiresApproval("read_inbox", true)).toBe(false);
    expect(toolRequiresApproval("contacts_get_or_create", true)).toBe(true);
    expect(toolRequiresApproval("notion_search_and_update", true)).toBe(true);
    expect(toolRequiresApproval("crm_get_then_upsert", true)).toBe(true);
  });
});

describe("connectorToolRequiresApproval", () => {
  it("matches read-only connector tool names", () => {
    expect(connectorToolRequiresApproval("list_items")).toBe(false);
    expect(connectorToolRequiresApproval("send_message")).toBe(true);
  });
});

describe("isApprovalAskBlock", () => {
  it("detects allow/deny approval cards", () => {
    expect(
      isApprovalAskBlock({
        kind: "ask",
        approvalEffectId: "effect-1",
        actions: [
          { id: "allow", label: "Allow once" },
          { id: "always", label: "Always allow" },
          { id: "deny", label: "Deny" },
        ],
      }),
    ).toBe(true);
    expect(isApprovalAskBlock({ kind: "ask" })).toBe(false);
    expect(
      isApprovalAskBlock({
        kind: "ask",
        approvalEffectId: "effect-1",
        actions: [{ id: "deny", label: "No" }],
      }),
    ).toBe(false);
  });
});

describe("isSecretAskBlock", () => {
  it("detects masked secret asks", () => {
    expect(isSecretAskBlock({ kind: "ask", input: "secret" })).toBe(true);
    expect(isSecretAskBlock({ kind: "ask", input: "text" })).toBe(false);
    expect(
      isSecretAskBlock({
        kind: "ask",
        input: "secret",
        approvalEffectId: "effect-1",
      }),
    ).toBe(false);
  });
});

describe("connectorKindFromToolName", () => {
  it("uses the first underscore segment", () => {
    expect(connectorKindFromToolName("gmail_send_email")).toBe("gmail");
  });

  it("prefers the longest matching connected provider slug", () => {
    expect(
      connectorKindFromToolName("microsoft_outlook_send_email", ["microsoft", "microsoft_outlook"]),
    ).toBe("microsoft_outlook");
  });
});

describe("resolveActionApproval", () => {
  const alwaysAllowDestination: ActionApprovalRule[] = [
    { effect: "always_allow", matchKind: "tool", matchValue: "destination.write" },
  ];
  const requireEmail: ActionApprovalRule[] = [
    { effect: "require_approval", matchKind: "category", matchValue: "email" },
  ];
  const requireDestination: ActionApprovalRule[] = [
    { effect: "require_approval", matchKind: "tool", matchValue: "destination.write" },
  ];

  it("skips approval when always-allow matches", () => {
    expect(
      resolveActionApproval({
        toolName: "destination.write",
        rules: alwaysAllowDestination,
      }),
    ).toBe("allow");
  });

  it("requires approval for email even when always-allow would match another tool", () => {
    expect(
      resolveActionApproval({
        toolName: "gmail_send_email",
        rules: [...alwaysAllowDestination, ...requireEmail],
      }),
    ).toBe("ask");
  });

  it("does not apply consequential categories to connector reads", () => {
    expect(
      resolveActionApproval({
        toolName: "gmail_list_threads",
        rules: requireEmail,
      }),
    ).toBe("allow");
  });

  it("lets an explicit rule gate a tool that is exempt by default", () => {
    expect(
      resolveActionApproval({
        toolName: "shell",
        rules: [{ effect: "require_approval", matchKind: "tool", matchValue: "shell" }],
      }),
    ).toBe("ask");
  });

  it("lets require_approval beat always-allow at the same specificity", () => {
    expect(
      resolveActionApproval({
        toolName: "destination.write",
        rules: [...alwaysAllowDestination, ...requireDestination],
      }),
    ).toBe("ask");
  });

  it("allows actions by default when no rules match", () => {
    expect(
      resolveActionApproval({
        toolName: "list_files",
        rules: [],
      }),
    ).toBe("allow");
    expect(
      resolveActionApproval({
        toolName: "destination.write",
        rules: [],
      }),
    ).toBe("allow");
  });

  it("lets a tool exception override a broader category rule", () => {
    expect(
      resolveActionApproval({
        toolName: "gmail_send_email",
        rules: [
          ...requireEmail,
          { effect: "always_allow", matchKind: "tool", matchValue: "gmail_send_email" },
        ],
      }),
    ).toBe("allow");
  });

  it("labels always-allow vs default allow", () => {
    expect(
      resolveActionApprovalDetail({
        toolName: "destination.write",
        rules: alwaysAllowDestination,
      }),
    ).toMatchObject({ decision: "allow", source: "always_allow" });
    expect(
      resolveActionApprovalDetail({
        toolName: "destination.write",
        rules: [],
      }),
    ).toMatchObject({ decision: "allow", source: "default" });
  });
});

describe("planActionGate", () => {
  const consequential = true;

  it("lets require_approval win without judging", () => {
    expect(
      planActionGate({
        resolved: {
          decision: "ask",
          source: "require_approval",
          matchingRules: [],
        },
        consequential,
        autoReviewEnabled: true,
        checkerConfigured: true,
      }),
    ).toBe("ask");
  });

  it("lets always_allow skip the judge", () => {
    expect(
      planActionGate({
        resolved: {
          decision: "allow",
          source: "always_allow",
          matchingRules: [],
        },
        consequential,
        autoReviewEnabled: true,
        checkerConfigured: true,
      }),
    ).toBe("allow");
  });

  it("judges consequential default actions when auto review is ready", () => {
    expect(
      planActionGate({
        resolved: { decision: "allow", source: "default", matchingRules: [] },
        consequential,
        autoReviewEnabled: true,
        checkerConfigured: true,
      }),
    ).toBe("judge");
  });

  it("stays YOLO when auto review is off or checker missing", () => {
    expect(
      planActionGate({
        resolved: { decision: "allow", source: "default", matchingRules: [] },
        consequential,
        autoReviewEnabled: false,
        checkerConfigured: true,
      }),
    ).toBe("allow");
    expect(
      planActionGate({
        resolved: { decision: "allow", source: "default", matchingRules: [] },
        consequential,
        autoReviewEnabled: true,
        checkerConfigured: false,
      }),
    ).toBe("allow");
  });

  it("does not judge non-consequential tools", () => {
    expect(
      planActionGate({
        resolved: { decision: "allow", source: "default", matchingRules: [] },
        consequential: false,
        autoReviewEnabled: true,
        checkerConfigured: true,
      }),
    ).toBe("allow");
  });
});

describe("applyJudgeDecision", () => {
  it("maps pass and ask", () => {
    expect(applyJudgeDecision({ decision: "pass", consequential: true })).toBe("allow");
    expect(applyJudgeDecision({ decision: "ask", consequential: true })).toBe("ask");
  });

  it("fails closed on consequential checker errors and open on exempt", () => {
    expect(applyJudgeDecision({ decision: "error", consequential: true })).toBe("ask");
    expect(applyJudgeDecision({ decision: "error", consequential: false })).toBe("allow");
  });
});
