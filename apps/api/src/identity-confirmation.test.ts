import { ORPCError } from "@orpc/server";
import { IDENTITY_CONFIRMATION_REQUIRED, isIdentityConfirmationRequired } from "@rakazo/contracts";
import { expect, it, vi } from "vitest";
import { requireIdentityConfirmation } from "./identity-confirmation.js";

const actor = {
  userId: "user-1",
  spaceId: "space-1",
  email: "person@example.test",
  isDeploymentOwner: false,
};

it("passes a session that recently confirmed its identity", async () => {
  const hasRecentIdentityConfirmation = vi.fn(async () => true);
  await requireIdentityConfirmation(
    { hasRecentIdentityConfirmation },
    { actor, sessionId: "session-1" },
  );
  expect(hasRecentIdentityConfirmation).toHaveBeenCalledWith({
    sessionId: "session-1",
    userId: "user-1",
  });
});

it.each([
  ["an unconfirmed session", { actor, sessionId: "session-1" }],
  ["a caller without a session", { actor }],
  ["a signed-out caller", { actor: null, sessionId: "session-1" }],
])("refuses %s with a stable code", async (_name, context) => {
  const error = await requireIdentityConfirmation(
    { hasRecentIdentityConfirmation: async () => false },
    context,
  ).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(ORPCError);
  expect(error).toMatchObject({ code: IDENTITY_CONFIRMATION_REQUIRED, status: 403 });
  expect(isIdentityConfirmationRequired(error)).toBe(true);
});
