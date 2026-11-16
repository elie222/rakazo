import { createHash } from "node:crypto";

export const ISSUE_LABEL = "exploratory-qa";
export const FINGERPRINT_PATTERN = /<!-- exploratory-qa-fingerprint: ([0-9a-f]{16}) -->/;
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

/** Text from the model goes into a public issue: no mentions, no hidden markup, bounded length. */
export function sanitize(text, max = 600) {
  const printable = [...String(text ?? "")]
    .filter((ch) => {
      const code = ch.codePointAt(0);
      return code === 9 || code === 10 || (code >= 32 && code !== 127);
    })
    .join("");
  const clean = printable
    .replace(/<!--|-->|`/g, "")
    .replace(/@([A-Za-z0-9-]+)/g, "`@$1`")
    .trim();
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

export function issueTitle(finding) {
  return `[QA] ${sanitize(finding.feature, 60)}: ${sanitize(finding.title, 100)}`;
}

export function issueBody(finding, { runUrl, artifactUrl }) {
  const steps = (finding.steps ?? []).slice(0, 20).map((s, i) => `${i + 1}. ${sanitize(s, 300)}`);
  const screenshot = finding.screenshot
    ? `\`${sanitize(finding.screenshot, 100)}\` in the [run's screenshots](${artifactUrl ?? runUrl})`
    : "None";
  return [
    "Found by the weekly exploratory QA agent on a preview stack with fake seed data.",
    "",
    `**Feature:** ${sanitize(finding.feature, 80)}`,
    `**Screen:** \`${normalizePath(finding.path)}\``,
    `**Bug key:** \`${slug(finding.key)}\``,
    "",
    "### Steps",
    steps.length > 0 ? steps.join("\n") : "Not recorded",
    "",
    "### Expected",
    sanitize(finding.expected),
    "",
    "### Actual",
    sanitize(finding.actual),
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
  const prefix = `[QA] ${featureName}:`.toLowerCase();
  return issues
    .filter((issue) =>
      String(issue.title ?? "")
        .toLowerCase()
        .startsWith(prefix),
    )
    .map((issue) => ({
      title: sanitize(issue.title.slice(prefix.length), 120),
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

/** Spend from token usage at the prices the run was given; stops before the next call once reached. */
export function createBudget({ limitUsd, inputUsdPerMTok, outputUsdPerMTok }) {
  for (const [name, value] of Object.entries({ limitUsd, inputUsdPerMTok, outputUsdPerMTok })) {
    if (!Number.isFinite(value) || value < 0)
      throw new Error(`${name} must be a non-negative number`);
  }
  if (limitUsd > LIMITS.budgetUsd) throw new Error(`The budget is capped at $${LIMITS.budgetUsd}`);
  let spentUsd = 0;
  return {
    charge(usage) {
      const input = Number(usage?.prompt_tokens ?? 0);
      const output = Number(usage?.completion_tokens ?? 0);
      spentUsd += (input * inputUsdPerMTok + output * outputUsdPerMTok) / 1_000_000;
      return spentUsd;
    },
    get spentUsd() {
      return spentUsd;
    },
    get exhausted() {
      return spentUsd >= limitUsd;
    },
  };
}

export function clampInt(value, fallback, max) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}
