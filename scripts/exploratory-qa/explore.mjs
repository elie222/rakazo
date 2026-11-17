#!/usr/bin/env node
// Explores product features on a running preview stack with a model driving a headless browser,
// and writes what it found to QA_OUT_DIR for file-issues.mjs. Run by .github/workflows/exploratory-qa.yml.
// The model is reached over the chat-completions protocol at MODEL_BASE_URL, so any compatible
// endpoint works. Spend stops at QA_BUDGET_USD, priced from token usage.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { explorePrompt, MAX_BUGS_PER_FEATURE } from "./explore.prompt.mjs";
import { exploreTools } from "./explore.tool-definition.mjs";
import {
  clampInt,
  createBudget,
  exploredAny,
  isoWeek,
  knownBugs,
  LIMITS,
  parseDemoAccount,
  parseFeatures,
  pickFeatures,
  runWorkers,
  stopReason,
} from "./qa-lib.mjs";

const MAX_STEPS = 80;
const MAX_OUTPUT_TOKENS = 2000;
const KEPT_TOOL_RESULTS = 3;
const SNAPSHOT_CHARS = 12_000;

const env = process.env;
const required = (name) => {
  if (!env[name]) throw new Error(`${name} is required`);
  return env[name];
};
const stackUrl = new URL(required("STACK_URL")).origin;
const model = {
  baseUrl: required("MODEL_BASE_URL").replace(/\/+$/, ""),
  apiKey: required("MODEL_API_KEY"),
  name: required("MODEL"),
};
const budget = createBudget({
  limitUsd: Number(required("QA_BUDGET_USD")),
  inputUsdPerMTok: Number(required("MODEL_INPUT_USD_PER_MTOK")),
  outputUsdPerMTok: Number(required("MODEL_OUTPUT_USD_PER_MTOK")),
});
const workers = clampInt(env.QA_WORKERS, 3, LIMITS.workers);
const minutes = clampInt(env.QA_MINUTES, 15, LIMITS.minutesPerWorker);
const outDir = env.QA_OUT_DIR || "exploratory-qa-out";
const shotsDir = join(outDir, "screenshots");
mkdirSync(shotsDir, { recursive: true });

const root = new URL("../../", import.meta.url);
const features = pickFeatures(parseFeatures(readFileSync(new URL("PRODUCT.md", root), "utf8")), {
  count: workers,
  names: (env.QA_FEATURES ?? "")
    // Section names can contain commas ("Connections, skills, and plugins").
    .split(/[;\n]/)
    .map((s) => s.trim())
    .filter(Boolean),
  week: isoWeek(new Date()),
});
const demoAccount = parseDemoAccount(
  readFileSync(new URL("infra/preview/demo-account.env", root), "utf8"),
);
const openIssues = env.QA_KNOWN_ISSUES ? JSON.parse(readFileSync(env.QA_KNOWN_ISSUES, "utf8")) : [];

// @playwright/test is a dependency of apps/web only, and pnpm does not hoist it to the root, so a static import from here cannot resolve it.
const requireFromWeb = createRequire(new URL("apps/web/package.json", root));
const playwright = await import(requireFromWeb.resolve("@playwright/test"));
const { chromium } = playwright.default ?? playwright;

// Every finding is saved as it is reported, so a run cut off by the step timeout still files what it found.
const reported = [];
const findingsFile = join(outDir, "findings.json");
const saveFindings = () => writeFileSync(findingsFile, `${JSON.stringify(reported, null, 2)}\n`);

async function callModel(messages) {
  const response = await fetch(`${model.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${model.apiKey}`, "content-type": "application/json" },
    body: JSON.stringify({
      model: model.name,
      messages,
      tools: exploreTools,
      max_tokens: MAX_OUTPUT_TOKENS,
    }),
    signal: AbortSignal.timeout(120_000),
  });
  if (!response.ok) throw new Error(`Model request failed with status ${response.status}`);
  const data = await response.json();
  budget.charge(data.usage);
  const message = data.choices?.[0]?.message;
  if (!message) throw new Error("Model returned no message");
  return message;
}

/** Only the last few tool results stay in full, so a long session does not resend every snapshot. */
function trimHistory(messages) {
  const toolIndexes = messages.flatMap((m, i) => (m.role === "tool" ? [i] : []));
  for (const i of toolIndexes.slice(0, -KEPT_TOOL_RESULTS)) {
    if (messages[i].content.length > 200) messages[i].content = "(older result omitted)";
  }
}

async function signIn(context) {
  const response = await context.request.post(`${stackUrl}/api/auth/sign-in/email`, {
    data: demoAccount,
    headers: { origin: stackUrl },
  });
  if (!response.ok()) throw new Error(`Demo sign-in failed with status ${response.status()}`);
}

async function exploreFeature(browser, feature, index) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const problems = [];
  page.on("pageerror", (error) => problems.push(`Page error: ${error.message}`));
  page.on(
    "console",
    (msg) => msg.type() === "error" && problems.push(`Console error: ${msg.text()}`),
  );
  page.on(
    "response",
    (res) =>
      res.status() >= 500 &&
      problems.push(`HTTP ${res.status()} from ${new URL(res.url()).pathname}`),
  );

  const findings = [];
  const taken = new Set();
  let shots = 0;
  let summary = "";
  const deadline = Date.now() + minutes * 60_000;
  const observe = (text) => {
    const seen = problems
      .splice(0)
      .slice(0, 10)
      .map((p) => p.slice(0, 300));
    return seen.length > 0 ? `${text}\n\nSince the last step:\n${seen.join("\n")}` : text;
  };
  const tools = {
    goto: async ({ path }) => {
      const url = new URL(path, stackUrl);
      if (url.origin !== stackUrl) return "Only paths on this deployment can be opened.";
      await page.goto(url.href);
      return `Opened ${url.pathname}`;
    },
    snapshot: async () =>
      `URL: ${new URL(page.url()).pathname}\n${(await page.locator("body").ariaSnapshot()).slice(0, SNAPSHOT_CHARS)}`,
    click: async ({ role, name }) => {
      await page.getByRole(role, { name }).first().click({ timeout: 5000 });
      return "Clicked";
    },
    fill: async ({ role, name, value }) => {
      await page.getByRole(role, { name }).first().fill(value, { timeout: 5000 });
      return "Filled";
    },
    press: async ({ key }) => {
      await page.keyboard.press(key);
      return "Pressed";
    },
    screenshot: async () => {
      shots += 1;
      const file = `${index + 1}-${shots}.png`;
      await page.screenshot({ path: join(shotsDir, file) });
      taken.add(file);
      return file;
    },
    report_bug: async (bug) => {
      if (findings.length >= MAX_BUGS_PER_FEATURE) return "Bug limit reached; call finish.";
      const screenshot = taken.has(bug.screenshot) ? bug.screenshot : await tools.screenshot();
      const finding = { ...bug, screenshot, feature: feature.name };
      findings.push(finding);
      reported.push(finding);
      saveFindings();
      return "Reported";
    },
    finish: async ({ summary: text }) => {
      summary = text;
      return "Done";
    },
  };

  let stopped;
  let steps = 0;
  const limit = () => stopReason({ steps, maxSteps: MAX_STEPS, deadline, budget });
  try {
    // Stay on the stack: nothing the agent does may reach another site.
    await context.route("**/*", (route) =>
      new URL(route.request().url()).origin === stackUrl ? route.continue() : route.abort(),
    );
    await signIn(context);
    await page.goto(stackUrl);
    const messages = [
      {
        role: "system",
        content: explorePrompt({ feature, knownBugs: knownBugs(openIssues, feature.name) }),
      },
      { role: "user", content: await tools.snapshot() },
    ];
    while (!summary && !stopped) {
      stopped = limit();
      if (stopped) break;
      trimHistory(messages);
      const message = await callModel(messages);
      // Some compatible endpoints refuse an assistant message whose content is null.
      messages.push({ ...message, content: message.content ?? "" });
      const calls = message.tool_calls ?? [];
      if (calls.length === 0) {
        steps += 1;
        messages.push({ role: "user", content: "Use a tool, or call finish." });
        continue;
      }
      for (const call of calls) {
        stopped = limit();
        if (stopped || summary) break;
        steps += 1;
        let result;
        try {
          const run = tools[call.function.name];
          result = run ? await run(JSON.parse(call.function.arguments || "{}")) : "Unknown tool";
        } catch (error) {
          result = `Failed: ${String(error.message).split("\n")[0].slice(0, 300)}`;
        }
        messages.push({ role: "tool", tool_call_id: call.id, content: observe(String(result)) });
      }
    }
    if (summary) stopped = "finished";
  } catch (error) {
    stopped = `error: ${String(error.message).slice(0, 200)}`;
  } finally {
    await context.close();
  }
  return { feature: feature.name, findings, stopped, summary };
}

const browser = await chromium.launch();
let results;
try {
  results = await runWorkers(features, (feature, i) => exploreFeature(browser, feature, i));
} finally {
  await browser.close();
}

saveFindings();
const lines = [
  "## Exploratory QA",
  "",
  `Spent about $${budget.spentUsd.toFixed(2)} of $${Number(env.QA_BUDGET_USD).toFixed(2)}.`,
  "",
  "| Feature | Bugs | Stopped |",
  "| --- | --- | --- |",
  ...results.map(
    (r) =>
      `| ${r.feature} | ${r.findings.length} | ${String(r.stopped).replace(/\s+/g, " ").replaceAll("|", "\\|")} |`,
  ),
];
writeFileSync(join(outDir, "summary.md"), `${lines.join("\n")}\n`);
console.log(lines.join("\n"));
if (!exploredAny(results)) {
  console.error("No feature was explored: every worker stopped with an error.");
  process.exitCode = 1;
}
