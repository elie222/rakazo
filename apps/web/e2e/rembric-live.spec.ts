import { randomUUID } from "node:crypto";
import type { BrowserContext, Page } from "@playwright/test";
import { expect, test } from "@playwright/test";
import type { SpaceNavigation } from "@rakazo/contracts";
import { callRembric } from "../../../packages/adapters/src/rembric-client";
import type { ModelEmulatorStep } from "../../../packages/testkit/src/model-emulator";
import { startModelEmulator } from "../../../packages/testkit/src/model-emulator";
import { signup } from "./helpers";

// These opt-in variables address disposable test infrastructure, not provider configuration.
const rembricUrl = process.env.REMBRIC_E2E_URL;
const adminToken = process.env.REMBRIC_E2E_ADMIN_TOKEN;
// In pinned Playwright, this disables _takePageSnapshot, not error-context.md itself.
// That file may still contain our sanitized error and static test source. Never use
// locator assertions on credential-bearing pages (they can embed their own DOM context).
if (rembricUrl && adminToken) process.env.PLAYWRIGHT_NO_COPY_PROMPT = "1";
test.use({ trace: "off", video: "off", screenshot: "off", actionTimeout: 10_000 });

type Memory = { id: string; memory: string; entity: string };
type ToolResult = {
  ok: boolean;
  value?: Memory[] | { id: string; expired: boolean };
};

test("real Rembric: operator provisioning and Pi shared-memory isolation", async ({
  page,
  browser,
}) => {
  test.skip(!rembricUrl || !adminToken, "Requires disposable Rembric URL and admin token");
  test.setTimeout(180_000);
  expect(process.env.AGENT_RUNTIME === "pi", "Run this journey with --runtime=pi").toBe(true);

  const steps: ModelEmulatorStep[] = [];
  const model = await startModelEmulator({ steps });
  let operator: BrowserContext | undefined;
  let stage = "signup";
  try {
    stage = "account signup";
    await signup(page, `rembric-${randomUUID()}@rakazo.test`, "password12", "Memory fixture");
    // completeOnboarding assumes a ready model (as in the scripted harness). Real Pi
    // correctly stops at model setup. Leave the UI before connecting our model so
    // onboarding cannot create Chief and consume deterministic model steps later.
    stage = "leave model onboarding";
    await page.goto("about:blank");
    stage = "verify no-model setup before bot creation";
    const setup = await rpc<{ needsModel: boolean }>(page, "", "me");
    expect(setup.needsModel === true, "Bots must be created before any model is available").toBe(
      true,
    );
    stage = "list initial Space";
    const navigation = await rpc<SpaceNavigation>(page, "", "spaces/list");
    const a = navigation.current.id;
    stage = "create second Space";
    const b = (await rpc<{ id: string }>(page, a, "spaces/create", { name: "Memory B" })).id;
    stage = "create unprovisioned Space";
    const missing = (
      await rpc<{ id: string }>(page, a, "spaces/create", { name: "Unprovisioned memory" })
    ).id;
    // No model is connected yet: bot intros must not consume the fixture's tool steps.
    const createBot = (space: string, name: string) =>
      rpc<{ id: string }>(page, space, "bots/create", {
        name,
        notifyOnFinish: false,
        instructions: "Execute the requested memory tool once, then finish.",
      });
    stage = "create first bot without model";
    const first = await createBot(a, "Memory A");
    stage = "create sibling bot without model";
    const sibling = await createBot(a, "Memory A sibling");
    stage = "create second Space bot without model";
    const second = await createBot(b, "Memory B");
    stage = "list created bots";
    for (const space of [a, b]) {
      const bots = await rpc<Array<{ id: string }>>(page, space, "bots/list");
      expect(bots.some((bot) => bot.id === (space === a ? first.id : second.id))).toBe(true);
    }

    stage = "operator context";
    // This context is owned and closed here, never the runner's credential-bearing page.
    // No storageState, recording, screenshots or attachments are produced from it.
    operator = await browser.newContext({ baseURL: rembricUrl });
    const dashboard = await operator.newPage();
    stage = "operator login page";
    await dashboard.goto("/dashboard/login");
    stage = "operator login form";
    await dashboard.getByLabel("Admin token", { exact: true }).fill(adminToken!);
    await dashboard.getByRole("button", { name: "SIGN IN →", exact: true }).click();
    await dashboard.waitForURL((url) => !url.pathname.includes("/login"));
    const slugs = new Map([a, b, missing].map((space) => [space, `notes-${randomUUID()}`]));
    const tokenA = await provisionProject(dashboard, slugs.get(a)!, (operation) => {
      stage = `operator A: ${operation}`;
    });
    const tokenB = await provisionProject(dashboard, slugs.get(b)!, (operation) => {
      stage = `operator B: ${operation}`;
    });

    stage = "connection input";
    const endpoint = (space: string) => `${rembricUrl!.replace(/\/$/, "")}/mcp/${slugs.get(space)}`;
    const connectInput = (space: string, token: string) => ({
      provider: "rembric",
      settings: { endpoint: endpoint(space) },
      credentials: { token },
      defaultMemoryScope: "shared",
      confirmSharedScope: true,
    });
    stage = "reject missing project";
    await rejected(page, missing, "memory/connectProvider", connectInput(missing, adminToken!));
    stage = "reject foreign project token";
    await rejected(page, b, "memory/connectProvider", connectInput(b, tokenA));
    stage = "reject isolated connection";
    await rejected(page, a, "memory/connectProvider", {
      ...connectInput(a, tokenA),
      defaultMemoryScope: "isolated",
    });
    stage = "connect project A";
    await rpc(page, a, "memory/connectProvider", connectInput(a, tokenA));
    stage = "connect project B";
    await rpc(page, b, "memory/connectProvider", connectInput(b, tokenB));
    stage = "reject isolated default";
    await rejected(page, a, "memory/setDefaultScope", { defaultMemoryScope: "isolated" });
    stage = "reject isolated bot override";
    await rejected(page, a, "bots/update", { botId: first.id, memoryScope: "isolated" });

    stage = "model connection";
    await rpc(page, a, "models/connect", {
      provider: model.model.provider,
      modelId: model.model.id,
      baseUrl: model.baseUrl,
      apiKey: "local",
      contextWindow: 160_000,
      maxTokens: 4096,
    });
    stage = "assign bot model";
    for (const [space, bot] of [
      [a, first],
      [a, sibling],
      [b, second],
    ] as const) {
      await rpc(page, space, "bots/update", {
        botId: bot.id,
        modelProvider: model.model.provider,
        modelId: model.model.id,
      });
    }
    stage = "allow fixture memory tools";
    for (const space of [a, b]) {
      for (const tool of ["save_memory", "recall_memory", "forget_memory"]) {
        await rpc(page, space, "approvalRules/set", {
          effect: "always_allow",
          matchKind: "tool",
          matchValue: tool,
        });
      }
    }

    let turn = 0;
    async function tool(
      space: string,
      botId: string,
      name: string,
      args: Record<string, unknown>,
    ): Promise<ToolResult> {
      stage = `Pi ${name} control ${turn + 1}`;
      const id = `memory-control-${++turn}`;
      let result: ToolResult | undefined;
      steps.push(
        {
          expect(request) {
            expect(request.tools?.some((item) => item.function.name === name)).toBe(true);
          },
          response: { type: "tool", id, name, arguments: args },
        },
        {
          expect(request) {
            const message = request.messages.findLast((item) => item.role === "tool");
            expect(message?.tool_call_id === id, "Expected the real executor tool result").toBe(
              true,
            );
            result = JSON.parse(String(message?.content)) as ToolResult;
          },
          response: { type: "text", text: id },
        },
      );
      const sent = await rpc<{ runId: string }>(page, space, "threads/send", {
        botId,
        text: `Execute fixture control ${id}.`,
      });
      await expect
        .poll(
          async () => {
            const recent = await rpc<{ runs: Array<{ runId: string; status: string }> }>(
              page,
              space,
              "runs/list",
              { filter: "recent" },
            );
            return recent.runs.find((run) => run.runId === sent.runId)?.status;
          },
          { timeout: 20_000, intervals: [100, 250, 500] },
        )
        .toBe("completed");
      model.assertComplete();
      expect(result !== undefined, "Executor returned a structured tool result").toBe(true);
      return result!;
    }
    const recall = async (space: string, botId: string, query: string) => {
      const result = await tool(space, botId, "recall_memory", { query });
      expect(result.ok === true && Array.isArray(result.value), "Recall succeeded").toBe(true);
      return result.value as Memory[];
    };
    const factA = `fixture-${randomUUID()}: the cobalt observatory uses copper keys.`;
    const factB = `fixture-${randomUUID()}: the amber greenhouse uses violet locks.`;
    stage = "Pi save and recall";
    expect((await tool(a, first.id, "save_memory", { content: factA })).ok).toBe(true);
    expect((await tool(b, second.id, "save_memory", { content: factB })).ok).toBe(true);
    const ownA = (await recall(a, first.id, factA)).find((row) => row.memory === factA);
    const ownB = (await recall(b, second.id, factB)).find((row) => row.memory === factB);
    expect(Boolean(ownA), "A recalls its saved fact").toBe(true);
    expect(Boolean(ownB), "B recalls its saved fact").toBe(true);
    expect((await recall(a, sibling.id, factA)).some((row) => row.id === ownA!.id)).toBe(true);
    expect((await recall(a, first.id, factB)).some((row) => row.id === ownB!.id)).toBe(false);
    expect((await recall(b, second.id, factA)).some((row) => row.id === ownA!.id)).toBe(false);

    stage = "known-ID access controls";
    // Only this non-search access control uses the guarded SDK helper directly. All memory
    // writes, recalls and archives above/below go through real Pi threads and the executor.
    async function batch(space: string, token: string, id: string) {
      return callRembric(
        { endpoint: endpoint(space), spaceId: space, projectId: "", token },
        "memory.get_batch",
        { ids: [id] },
        AbortSignal.timeout(10_000),
        true,
      );
    }
    for (const [space, token, own, foreign] of [
      [a, tokenA, ownA!, ownB!],
      [b, tokenB, ownB!, ownA!],
    ] as const) {
      const positive = await batch(space, token, own.id);
      expect(
        Array.isArray(positive.memories) &&
          positive.memories.some((row: { id: string }) => row.id === own.id) &&
          Array.isArray(positive.errors) &&
          positive.errors.length === 0,
        "Known own ID is accessible",
      ).toBe(true);
      let denied = false;
      try {
        const negative = await batch(space, token, foreign.id);
        denied =
          Array.isArray(negative.memories) &&
          negative.memories.length === 0 &&
          Array.isArray(negative.errors) &&
          negative.errors.length > 0;
      } catch {
        denied = true;
      }
      expect(denied, "Known foreign ID is inaccessible").toBe(true);
    }

    stage = "Pi forget and archive controls";
    // Omit entity deliberately: force the provider's get_batch ownership check, not its
    // earlier entity guard. The source fact must remain recallable by its owner.
    expect((await tool(a, first.id, "forget_memory", { id: ownB!.id })).ok).toBe(false);
    expect((await recall(b, second.id, factB)).some((row) => row.id === ownB!.id)).toBe(true);
    const archived = await tool(a, first.id, "forget_memory", { id: ownA!.id });
    expect(
      archived.ok === true &&
        !Array.isArray(archived.value) &&
        archived.value?.id === ownA!.id &&
        archived.value.expired === true,
      "Own fact was archived",
    ).toBe(true);
    expect((await recall(a, sibling.id, factA)).some((row) => row.id === ownA!.id)).toBe(false);
    expect((await recall(b, second.id, factB)).some((row) => row.id === ownB!.id)).toBe(true);
    stage = "explicitly share project B with Space A";
    await rpc(page, a, "memory/connectProvider", connectInput(b, tokenB));
    expect((await recall(a, first.id, factB)).some((row) => row.id === ownB!.id)).toBe(true);
    model.assertComplete();
  } catch (error) {
    // Preserve only a closed error category, never messages/stacks/causes that might
    // contain form values, token redirects, RPC payloads or DOM assertion context.
    const category =
      error instanceof Error && ["TimeoutError", "TypeError", "SyntaxError"].includes(error.name)
        ? error.name
        : error instanceof Error && "matcherResult" in error
          ? "AssertionError"
          : "Error";
    throw new Error(`Rembric fixture ${category} during ${stage}; credentials suppressed.`);
  } finally {
    try {
      await operator?.close();
    } finally {
      await model.close();
    }
  }
});

async function provisionProject(
  page: Page,
  slug: string,
  stage: (operation: string) => void,
): Promise<string> {
  stage("project form");
  await page.goto("/dashboard/projects");
  await page.getByRole("button", { name: "New project", exact: true }).click();
  await page.getByLabel("Slug", { exact: true }).fill(slug);
  stage("create project");
  await page.getByRole("button", { name: "Create project", exact: true }).click();
  await page.waitForURL(
    (url) => url.pathname === "/dashboard/projects" && url.searchParams.has("created"),
  );
  expect(new URL(page.url()).searchParams.get("created") === slug, "Project created").toBe(true);
  await page.goto("/dashboard/tokens");
  stage("token form");
  await page.getByRole("button", { name: "New token", exact: true }).click();
  await page.getByLabel("Name", { exact: true }).fill(`fixture-${slug}`);
  await page.getByRole("checkbox", { name: slug, exact: true }).check();
  stage("token write access");
  // WRITE is the dashboard's default. Check the actual submitted value before minting.
  expect(
    await page
      .locator("form")
      .filter({ has: page.locator("#token-create-name") })
      .evaluate((form) => new FormData(form as HTMLFormElement).get("access") === "write"),
    "Project token grants write access",
  ).toBe(true);
  stage("mint token");
  await page.getByRole("button", { name: "Create token", exact: true }).click();
  await page.waitForURL(
    (url) => url.pathname === "/dashboard/tokens" && url.searchParams.has("created"),
  );
  stage("read minted token in memory");
  const token = new URL(page.url()).searchParams.get("created");
  const displayed = await page
    .locator("code")
    .evaluateAll((elements) => elements.map((node) => node.textContent));
  expect(
    typeof token === "string" && token.length > 0 && displayed.includes(token),
    "Project token minted and displayed once",
  ).toBe(true);
  stage("clear token redirect");
  await page.goto("/dashboard/tokens");
  return token!;
}

async function envelope(page: Page, space: string, procedure: string, input: unknown = {}) {
  const response = await page.request.post(`/rpc/${procedure}`, {
    headers: space ? { "x-rakazo-space-id": space } : {},
    data: { json: input },
  });
  const body = (await response.json()) as { json?: unknown; error?: unknown };
  return { accepted: response.ok() && !body.error, value: body.json };
}

async function rpc<T = unknown>(
  page: Page,
  space: string,
  procedure: string,
  input: unknown = {},
): Promise<T> {
  const result = await envelope(page, space, procedure, input);
  expect(result.accepted, `${procedure} accepted`).toBe(true);
  return result.value as T;
}

async function rejected(page: Page, space: string, procedure: string, input: unknown) {
  expect((await envelope(page, space, procedure, input)).accepted, `${procedure} rejected`).toBe(
    false,
  );
}
