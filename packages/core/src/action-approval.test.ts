import { describe, expect, it } from "vitest";
import {
  type ActionApprovalRule,
  applyJudgeDecision,
  connectorKindFromToolName,
  connectorReadRequiresApproval,
  connectorToolRequiresApproval,
  isApprovalAskBlock,
  isOwnerStartedRun,
  isSecretAskBlock,
  newSiteOutcome,
  outboundSiteGate,
  planActionGate,
  resolveActionApproval,
  resolveActionApprovalDetail,
  toolRequiresApproval,
  toolRequiresExplicitApproval,
  toolResultTaintsRun,
  unattendedTriggerToolRequiresApproval,
  watchToolRefusal,
} from "./action-approval.js";

describe("toolRequiresApproval", () => {
  it("requires approval for consequential builtins and connector writes", () => {
    expect(toolRequiresApproval("destination.write", true)).toBe(true);
    expect(toolRequiresApproval("secret_request", false)).toBe(true);
    expect(toolRequiresApproval("forget_secret", false)).toBe(true);
    expect(toolRequiresApproval("forget_memory", false)).toBe(true);
    expect(toolRequiresApproval("list_secrets", false)).toBe(false);
    expect(toolRequiresApproval("delete_bot", false)).toBe(true);
    expect(toolRequiresApproval("archive_bot", false)).toBe(true);
    expect(toolRequiresApproval("cloud_agent_launch", false)).toBe(true);
    expect(toolRequiresApproval("create_space", false)).toBe(true);
    expect(toolRequiresExplicitApproval("create_space")).toBe(true);
    expect(toolRequiresExplicitApproval("save_shared_memory")).toBe(false);
    expect(toolRequiresExplicitApproval("archive_bot")).toBe(false);
  });

  it("does not gate read-only or local work", () => {
    for (const name of [
      "list_files",
      "computer_observe",
      "read_file",
      "write_file",
      "shell",
      "remember",
      "save_shared_memory",
      "spawn_bot",
      "run_subagent",
    ]) {
      expect(toolRequiresApproval(name, false)).toBe(false);
    }
  });

  it("always asks before bot management writes that touch several bots, cost money or rewrite a bot", () => {
    for (const name of [
      "create_group",
      "update_group",
      "set_child_instructions",
      "set_child_bot_model",
      "create_child_routine",
    ]) {
      expect(toolRequiresApproval(name, false)).toBe(true);
      expect(toolRequiresExplicitApproval(name)).toBe(true);
    }
  });

  it("never asks before reading the bots it manages or organizing the sidebar", () => {
    for (const name of ["list_fleet", "organize_bot", "update_bot"]) {
      expect(toolRequiresApproval(name, false)).toBe(false);
      expect(toolRequiresExplicitApproval(name)).toBe(false);
    }
    expect(toolRequiresApproval("organize_bot", true)).toBe(false);
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

  it("requires approval for a declared write whatever its name says", () => {
    expect(connectorToolRequiresApproval("read_profile_card", false)).toBe(true);
    expect(connectorToolRequiresApproval("find_validator_record", false)).toBe(true);
    expect(connectorToolRequiresApproval("read_profile_card", true)).toBe(false);
    expect(connectorToolRequiresApproval("read_profile_card")).toBe(false);
  });

  it("never lets a declared read relax a mutating or ambiguous name", () => {
    expect(connectorToolRequiresApproval("delete_item", true)).toBe(true);
    expect(connectorToolRequiresApproval("get_or_create_contact", true)).toBe(true);
    expect(connectorToolRequiresApproval("profile_card", true)).toBe(true);
  });
});

describe("resolveActionApprovalDetail", () => {
  it("applies category rules to declared writes with read-looking names", () => {
    const rules = [
      { effect: "require_approval" as const, matchKind: "category" as const, matchValue: "email" },
    ];
    const base = { toolName: "gmail_read_thread", connectorKind: "gmail", rules };
    expect(resolveActionApprovalDetail(base).decision).toBe("allow");
    expect(resolveActionApprovalDetail({ ...base, readOnly: false }).decision).toBe("ask");
  });
});

describe("isOwnerStartedRun", () => {
  it.each([
    ["user", false, true],
    ["call_end", false, true],
    ["follow_up", true, true],
    ["follow_up", false, false],
    ["bot_message", true, false],
    ["messaging", true, false],
    ["spawn", true, false],
    ["tickets", true, false],
    ["webhook", true, false],
    ["routine", true, false],
    ["resume", true, false],
    ["unknown", true, false],
  ])("treats %s (follow-up from user: %s) as owner-started: %s", (trigger, fromUser, expected) => {
    expect(isOwnerStartedRun(trigger, fromUser)).toBe(expected);
  });
});

describe("unattendedTriggerToolRequiresApproval", () => {
  it("forces approval for webhook-triggered local side effects", () => {
    for (const name of ["shell", "write_file", "browser_act", "computer_act"]) {
      expect(unattendedTriggerToolRequiresApproval("webhook", name, false)).toBe(true);
    }
  });

  it("allows webhook-triggered reads to stay unattended", () => {
    for (const name of [
      "computer_observe",
      "read_file",
      "web_search",
      "browser_snapshot",
      "request_takeover",
      "run_subagent",
      "list_fleet",
    ]) {
      expect(unattendedTriggerToolRequiresApproval("webhook", name, false)).toBe(false);
    }
    expect(unattendedTriggerToolRequiresApproval("webhook", "github_get_issue", true)).toBe(false);
  });

  it("forces approval for webhook-triggered connector writes regardless of normal rules", () => {
    expect(unattendedTriggerToolRequiresApproval("webhook", "github_create_issue", true)).toBe(
      true,
    );
    expect(unattendedTriggerToolRequiresApproval("user", "shell", false)).toBe(false);
  });

  it("forces approval for webhook-triggered declared writes with read-looking names", () => {
    for (const name of ["read_profile_card", "find_validator_record", "get_status"]) {
      expect(unattendedTriggerToolRequiresApproval("webhook", name, true, false)).toBe(true);
      expect(toolRequiresApproval(name, true, false)).toBe(true);
    }
    expect(unattendedTriggerToolRequiresApproval("webhook", "read_profile_card", true, true)).toBe(
      false,
    );
    expect(unattendedTriggerToolRequiresApproval("webhook", "delete_record", true, true)).toBe(
      true,
    );
    expect(unattendedTriggerToolRequiresApproval("user", "read_profile_card", true, false)).toBe(
      false,
    );
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

  it("allows without judging when approvals are skipped, except under a require rule", () => {
    const gate = (decision: "ask" | "allow") =>
      planActionGate({
        resolved: {
          decision,
          source: decision === "ask" ? "require_approval" : "default",
          matchingRules: [],
        },
        consequential,
        autoReviewEnabled: true,
        checkerConfigured: true,
        newDestination: true,
        skipApprovals: true,
      });
    expect(gate("allow")).toBe("allow");
    expect(gate("ask")).toBe("ask");
  });

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

  it("sends a new site to Auto Review, even with a rule for the whole tool", () => {
    const gate = (source: "default" | "always_allow") =>
      planActionGate({
        resolved: { decision: "allow", source, matchingRules: [] },
        consequential,
        autoReviewEnabled: true,
        checkerConfigured: true,
        newDestination: true,
      });
    expect(gate("default")).toBe("judge");
    expect(gate("always_allow")).toBe("judge");
  });

  it("asks before a new site when Auto Review is off or has no checker", () => {
    for (const [autoReviewEnabled, checkerConfigured] of [
      [false, true],
      [true, false],
    ] as const) {
      expect(
        planActionGate({
          resolved: { decision: "allow", source: "always_allow", matchingRules: [] },
          consequential,
          autoReviewEnabled,
          checkerConfigured,
          newDestination: true,
        }),
      ).toBe("ask");
    }
  });

  it("lets a require_approval rule ask about a new site without judging", () => {
    expect(
      planActionGate({
        resolved: { decision: "ask", source: "require_approval", matchingRules: [] },
        consequential,
        autoReviewEnabled: true,
        checkerConfigured: true,
        newDestination: true,
      }),
    ).toBe("ask");
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

describe("newSiteOutcome", () => {
  it("allows a new site Auto Review passed, in any run", () => {
    for (const trigger of ["user", "routine", "webhook"]) {
      expect(newSiteOutcome({ trigger, decision: "allow" })).toBe("allow");
    }
  });

  it("asks a person about a new site that was not passed", () => {
    for (const trigger of ["user", "follow_up", "routine", "messaging"]) {
      expect(newSiteOutcome({ trigger, decision: "ask" })).toBe("ask");
    }
  });

  it("refuses it in a webhook run, which has nobody to ask", () => {
    expect(newSiteOutcome({ trigger: "webhook", decision: "ask" })).toBe("deny");
  });
});

describe("watchToolRefusal", () => {
  const rule = (matchKind: string, matchValue: string, effect = "require_approval") =>
    ({ effect, matchKind, matchValue }) as Parameters<typeof watchToolRefusal>[0]["rules"][number];

  it("allows only explicitly declared reads", () => {
    expect(watchToolRefusal({ toolName: "drive_files", readOnly: true, rules: [] })).toBeNull();
  });

  it.each(["brain_changed", "gmail_search_threads", "clickbot_tasks", "send_email"])(
    "refuses missing metadata even for %s",
    (toolName) => {
      expect(watchToolRefusal({ toolName, rules: [] })).toMatch(/can change data/);
      expect(watchToolRefusal({ toolName, readOnly: false, rules: [] })).toMatch(/can change data/);
    },
  );

  it("refuses a read the space's rules would ask about", () => {
    expect(
      watchToolRefusal({
        toolName: "brain_search",
        readOnly: true,
        rules: [rule("tool", "brain_search")],
      }),
    ).toMatch(/approval/);
    expect(
      watchToolRefusal({
        toolName: "brain_search",
        readOnly: true,
        rules: [rule("tool", "brain_search", "always_allow")],
      }),
    ).toBeNull();
  });
});

describe("outboundSiteGate", () => {
  const siteRule: ActionApprovalRule = {
    effect: "always_allow",
    matchKind: "site",
    matchValue: "example.com",
  };

  it("lets a run reach sites it was given", () => {
    expect(outboundSiteGate({ site: "example.com", trusted: true, rules: [] })).toBe("allow");
  });

  it("marks any other site new, even with a rule for the whole tool", () => {
    expect(outboundSiteGate({ site: "attacker.test", trusted: false, rules: [] })).toBe("new");
    expect(
      outboundSiteGate({
        site: "attacker.test",
        trusted: false,
        rules: [{ effect: "always_allow", matchKind: "tool", matchValue: "web_fetch" }],
      }),
    ).toBe("new");
  });

  it("allows a site the owner always allowed, and only that site", () => {
    expect(outboundSiteGate({ site: "example.com", trusted: false, rules: [siteRule] })).toBe(
      "allow",
    );
    expect(outboundSiteGate({ site: "other.com", trusted: false, rules: [siteRule] })).toBe("new");
  });

  it("matches site rules ahead of tool rules", () => {
    expect(
      resolveActionApprovalDetail({
        toolName: "web_fetch",
        site: "example.com",
        rules: [
          { effect: "require_approval", matchKind: "tool", matchValue: "web_fetch" },
          siteRule,
        ],
      }).decision,
    ).toBe("allow");
    expect(
      resolveActionApprovalDetail({ toolName: "web_fetch", site: "other.com", rules: [siteRule] })
        .source,
    ).toBe("default");
  });
});

describe("connectorReadRequiresApproval", () => {
  it("keeps reads free until outside content enters the run", () => {
    expect(connectorReadRequiresApproval({ tainted: false, connectorTrusted: false })).toBe(false);
  });

  it("keeps reads free on a connector the run already used or was approved for", () => {
    expect(connectorReadRequiresApproval({ tainted: true, connectorTrusted: true })).toBe(false);
  });

  it("asks before a read on a new connector once the run is tainted", () => {
    expect(connectorReadRequiresApproval({ tainted: true, connectorTrusted: false })).toBe(true);
  });
});

describe("toolResultTaintsRun", () => {
  it("treats outside content as taint, including connector tools and new tools", () => {
    for (const tool of [
      "web_fetch",
      "web_search",
      "browser_snapshot",
      "computer_observe",
      "shell",
      "read_file",
      "run_subagent",
      "gmail_list_messages",
      "some_future_tool",
    ]) {
      expect(toolResultTaintsRun(tool)).toBe(true);
    }
  });

  it("does not taint on the bot's own writes and saved state", () => {
    for (const tool of ["ask_user", "remember", "recall_memory", "skill_read", "write_file"]) {
      expect(toolResultTaintsRun(tool)).toBe(false);
    }
  });
});

it("requires human confirmation to approve an agent connection", () => {
  expect(toolRequiresExplicitApproval("respond_agent_connection")).toBe(true);
  expect(toolRequiresApproval("respond_agent_connection", false)).toBe(true);
});
