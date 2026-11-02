import { expect, it } from "vitest";
import { appContract } from "./rpc.js";

it("accepts explicit ask rules without rejecting existing long targets", () => {
  const schema = appContract.approvalRules.set["~orpc"].inputSchema;
  if (!schema) throw new Error("missing input schema");
  const rule = {
    scope: "account",
    effect: "require_approval",
    matchKind: "tool",
    matchValue: " write_file ",
  };
  expect(schema.parse(rule).matchValue).toBe("write_file");
  for (const matchValue of [" "]) {
    expect(schema.safeParse({ ...rule, matchValue }).success).toBe(false);
  }
  expect(schema.safeParse({ ...rule, matchValue: "x".repeat(500) }).success).toBe(true);
  expect(schema.safeParse({ ...rule, matchKind: "category" }).success).toBe(false);
});
