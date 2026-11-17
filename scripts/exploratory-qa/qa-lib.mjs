import { createHash } from "node:crypto";

export const ISSUE_LABEL = "exploratory-qa";
// Anchored to the end of the body, where only our own comment sits, so model text above it cannot pose as one.
export const FINGERPRINT_PATTERN = /<!-- exploratory-qa-fingerprint: ([0-9a-f]{16}) -->\s*$/;
export const SCREENSHOT_NAME = /^[0-9]+-[0-9]+\.png$/;
export const LIMITS = { workers: 6, minutesPerWorker: 30, budgetUsd: 25, issuesPerRun: 10 };

// Sections that describe documents or server operation rather than something a browser can use.
const NOT_EXPLORABLE = new Set(["Status and use", "Deployment administration and host access"]);

/** The product features to explore: each `##` section of PRODUCT.md with its text as the brief. */
export function parseFeatures(markdown) {
  const features = [];
  let current;
  for (const line of markdown.split("\n")) {
    const heading = /^## (.+)$/.exec(line);
    if (heading) {
      current = { name: heading[1].trim(), brief: "" };
      if (!NOT_EXPLORABLE.has(current.name)) features.push(current);
    } else if (current) {
      current.brief += `${line}\n`;
    }
  }
  return features.map((f) => ({ name: f.name, brief: f.brief.trim() }));
}

/** Named features when given, otherwise a rotation that moves on each week so every feature gets a turn. */
export function pickFeatures(features, { count, names = [], week }) {
  if (names.length > 0) {
    const wanted = names.map((n) => n.toLowerCase());
    const picked = features.filter((f) => wanted.includes(f.name.toLowerCase()));
    const missing = names.filter(
      (n) => !picked.some((f) => f.name.toLowerCase() === n.toLowerCase()),
    );
    if (missing.length > 0) throw new Error(`Unknown features: ${missing.join(", ")}`);
    return picked.slice(0, count);
  }
  const n = Math.min(count, features.length);
  const start = (week * n) % features.length;
  return Array.from({ length: n }, (_, i) => features[(start + i) % features.length]);
}

export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7);
}

/** A path with ids removed, so the same screen gives the same fingerprint whatever record it showed. */
export function normalizePath(path) {
  let pathname = String(path ?? "/");
  try {
    pathname = new URL(pathname, "http://stack.invalid").pathname;
  } catch {
    pathname = "/";
  }
  return (
    pathname
      .split("/")
      .map((part) =>
        /^[0-9]+$|^[0-9a-f-]{16,}$|^[a-z0-9]{20,}$|^c[a-z0-9]{20,}$/i.test(part) ? ":id" : part,
      )
      .join("/")
      .toLowerCase()
      .replace(/\/+$/, "") || "/"
  );
}

function slug(text) {
  return String(text ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

/** Stable across runs for the same bug: feature, screen and the agent's short bug key, never its prose. */
export function fingerprint(finding) {
  const input = [slug(finding.feature), normalizePath(finding.path), slug(finding.key)].join("|");
  return createHash("sha256").update(input).digest("hex").slice(0, 16);
}

/** Model text with control characters removed and its length bounded. */
export function plainText(text, max = 600) {
  const clean = [...String(text ?? "")]
    .filter((ch) => {
      const code = ch.codePointAt(0);
      return code === 9 || code === 10 || (code >= 32 && code !== 127);
    })
    .join("")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** Model text for a public issue body, in a fenced code block so no Markdown, HTML or mention in it renders: the fence is longer than any backtick run the text holds. */
export function codeBlock(text, max = 600) {
  const clean = plainText(text, max) || "Not recorded";
  const longestRun = Math.max(0, ...(clean.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}text\n${clean}\n${fence}`;
}

/** Issue titles are plain text on GitHub: no markup renders and no mention notifies. */
export function issueTitle(finding) {
  return `${issueTitlePrefix(finding.feature)} ${plainText(finding.title, 100)}`;
}

/** The start of every issue title for a feature; knownBugs reads titles back by it. */
export function issueTitlePrefix(featureName) {
  return `[QA] ${plainText(featureName, 60)}:`;
}

/** Only our own parts are Markdown; every piece of model text sits in a code block. The feature name is ours, from PRODUCT.md. */
export function issueBody(finding, { runUrl, artifactUrl }) {
  const steps = (finding.steps ?? [])
    .slice(0, 20)
    .map((s, i) => `${i + 1}. ${plainText(s, 300).replace(/\n/g, " ")}`)
    .join("\n");
  const screenshot = SCREENSHOT_NAME.test(finding.screenshot ?? "")
    ? `\`${finding.screenshot}\` in the [run's screenshots](${artifactUrl ?? runUrl})`
    : "None";
  return [
    "Found by the weekly exploratory QA agent on a preview stack with fake seed data.",
    "",
    `**Feature:** ${plainText(finding.feature, 80)}`,
    `**Screen:** \`${normalizePath(finding.path)}\``,
    `**Bug key:** \`${slug(finding.key)}\``,
    "",
    "### Steps",
    codeBlock(steps, 7000),
    "",
    "### Expected",
    codeBlock(finding.expected),
    "",
    "### Actual",
    codeBlock(finding.actual),
    "",
    `**Screenshot:** ${screenshot}`,
    `**Run:** ${runUrl}`,
    "",
    `<!-- exploratory-qa-fingerprint: ${fingerprint(finding)} -->`,
  ].join("\n");
}

export function fingerprintsIn(issues) {
  const found = new Set();
  for (const issue of issues) {
    const match = FINGERPRINT_PATTERN.exec(issue.body ?? "");
    if (match) found.add(match[1]);
  }
  return found;
}

/** Open bugs for a feature, so its agent can recognize them instead of reporting them again. */
export function knownBugs(issues, featureName) {
  const prefix = issueTitlePrefix(featureName).toLowerCase();
  return issues
    .filter((issue) =>
      String(issue.title ?? "")
        .toLowerCase()
        .startsWith(prefix),
    )
    .map((issue) => ({
      title: plainText(issue.title.slice(prefix.length), 120),
      key: /\*\*Bug key:\*\* `([a-z0-9-]+)`/.exec(issue.body ?? "")?.[1],
      screen: /\*\*Screen:\*\* `([^`\n]+)`/.exec(issue.body ?? "")?.[1] ?? "/",
    }))
    .filter((bug) => bug.key)
    .slice(0, 30);
}

function isFinding(value) {
  return (
    typeof value === "object" &&
    value !== null &&
    ["feature", "title", "key", "expected", "actual"].every(
      (k) => typeof value[k] === "string" && value[k].trim(),
    )
  );
}

/** At most one issue per distinct bug: drops bugs already open and repeats within the run. */
export function planIssues(findings, openIssues, maxIssues = LIMITS.issuesPerRun) {
  const seen = fingerprintsIn(openIssues);
  const planned = [];
  for (const finding of Array.isArray(findings) ? findings.filter(isFinding) : []) {
    const id = fingerprint(finding);
    if (seen.has(id)) continue;
    seen.add(id);
    planned.push(finding);
    if (planned.length >= maxIssues) break;
  }
  return planned;
}

/** Spend from token usage at the prices the run was given; stops before the next call once reached. A response without usable token counts stops the whole run, since its cost is unknown. */
export function createBudget({ limitUsd, inputUsdPerMTok, outputUsdPerMTok }) {
  // A zero price would leave spend at zero and the cap unenforced.
  for (const [name, value] of Object.entries({ limitUsd, inputUsdPerMTok, outputUsdPerMTok })) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  }
  if (limitUsd > LIMITS.budgetUsd) throw new Error(`The budget is capped at $${LIMITS.budgetUsd}`);
  let spentUsd = 0;
  let unpriced = false;
  const isCount = (n) => typeof n === "number" && Number.isFinite(n) && n >= 0;
  return {
    charge(usage) {
      const input = usage?.prompt_tokens;
      const output = usage?.completion_tokens;
      if (!isCount(input) || !isCount(output)) {
        unpriced = true;
        throw new Error("The model response had no usable token usage, so its cost is unknown");
      }
      spentUsd += (input * inputUsdPerMTok + output * outputUsdPerMTok) / 1_000_000;
      return spentUsd;
    },
    get spentUsd() {
      return spentUsd;
    },
    get exhausted() {
      return unpriced || spentUsd >= limitUsd;
    },
  };
}

/** Runs every worker to the end: one that throws is reported as stopped, never losing the others' findings. */
export async function runWorkers(features, work) {
  const settled = await Promise.allSettled(features.map((feature, i) => work(feature, i)));
  return settled.map((outcome, i) =>
    outcome.status === "fulfilled"
      ? outcome.value
      : {
          feature: features[i].name,
          findings: [],
          stopped: `error: ${String(outcome.reason?.message ?? outcome.reason).slice(0, 200)}`,
          summary: "",
        },
  );
}

/** A run where no worker got to explore, such as every sign-in or model call failing, is a failed run rather than a clean one. */
export function exploredAny(results) {
  return results.some((result) => !String(result.stopped ?? "").startsWith("error:"));
}

/** The preview stack's demo account, from the same file its start script reads. */
export function parseDemoAccount(text) {
  const values = Object.fromEntries(
    text
      .split("\n")
      .map((line) => /^([A-Z_]+)=(.*)$/.exec(line.trim()))
      .filter(Boolean)
      .map(([, key, value]) => [key, value]),
  );
  if (!values.OWNER_EMAIL || !values.OWNER_PASSWORD)
    throw new Error("The demo account file needs OWNER_EMAIL and OWNER_PASSWORD");
  return { email: values.OWNER_EMAIL, password: values.OWNER_PASSWORD };
}

export function clampInt(value, fallback, max) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

/** Why a worker must stop before its next model call or tool call, or undefined to go on. */
export function stopReason({ steps, maxSteps, deadline, budget, now = Date.now() }) {
  if (budget.exhausted) return "budget";
  if (now > deadline) return "time limit";
  if (steps >= maxSteps) return "step limit";
  return undefined;
}
