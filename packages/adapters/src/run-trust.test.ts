import { describe, expect, it, vi } from "vitest";
import type { ExecutorDeps } from "./executor-deps.js";
import { connectorTrustKeys, createRunTrustLoaders } from "./run-trust.js";

describe("connectorTrustKeys", () => {
  const providers = ["gmail", "slack"];

  it("keys a batch by the app each action reaches", () => {
    expect(
      connectorTrustKeys(
        ["GMAIL_LIST_THREADS", "SLACK_LIST_CHANNELS", "NOTION_SEARCH"],
        { connectorId: "composio" },
        "composio",
        providers,
      ),
    ).toEqual(["kind:composio:gmail", "kind:composio:slack", "kind:composio:notion_search"]);
  });

  it("keeps the same action on two MCP servers apart", () => {
    const keys = (resourceId: string) =>
      connectorTrustKeys(
        ["GMAIL_LIST_THREADS"],
        { connectorId: "mcp", resourceId },
        "mcp",
        providers,
      );
    expect(keys("server-a")).toEqual(["resource:mcp:server-a:gmail"]);
    expect(keys("server-b")).not.toEqual(keys("server-a"));
  });

  it("keys a call that is not a batch by its connection", () => {
    expect(
      connectorTrustKeys(undefined, { connectorId: "mcp", resourceId: "server-a" }, "mcp", []),
    ).toEqual(["resource:mcp:server-a"]);
  });
});

describe("owner words", () => {
  const routinePrompt = "Check https://example.com/status and report.";
  function loaders(
    run: { trigger: string; promptCredentialId: string | null },
    findMany = vi.fn(async () => [{ name: "Status", prompt: routinePrompt }]),
  ) {
    const deps = { prisma: { routine: { findMany } } } as unknown as ExecutorDeps;
    return createRunTrustLoaders(deps, {
      run: { userId: "user-1", spaceId: "space-1", ...run },
      runId: "run-1",
      botId: "bot-1",
      taskPrompt: routinePrompt,
      ownerStartedRun: false,
      messagingChannelRun: false,
      sourceMessage: null,
      connectedPlugins: [],
    });
  }

  it("takes a routine the person wrote as their words", async () => {
    const words = await loaders({ trigger: "routine", promptCredentialId: null }).loadOwnerWords();
    expect(words).toContain("https://example.com/status");
  });

  it("does not take a routine an API key wrote as the person's words", async () => {
    const words = await loaders({
      trigger: "routine",
      promptCredentialId: "key-1",
    }).loadOwnerWords();
    expect(words).toBe("");
  });

  it("matches a webhook only against routines the person wrote", async () => {
    const findMany = vi.fn(async () => []);
    await loaders({ trigger: "webhook", promptCredentialId: null }, findMany).loadOwnerWords();
    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ promptCredentialId: null }) }),
    );
  });
});
