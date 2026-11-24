import commitMarker from "../screenshot-commit-marker.json" with { type: "json" };
import type { PlaywrightScreenshot } from "./playwright-report-dashboard.js";

export const PLAYWRIGHT_PR_SCREENSHOT_COMMENT_MARKER = "<!-- rakazo-playwright-screenshots -->";
export const PLAYWRIGHT_PR_FEATURE_FRAME_LIMIT = 8;

export type PlaywrightPrCommentScreenshot = Pick<
  PlaywrightScreenshot,
  "captureType" | "comparison" | "fileName" | "source" | "title"
>;

export type PlaywrightPrFeatureFrame = PlaywrightPrCommentScreenshot & {
  kind: "changed" | "new";
};

export type PlaywrightPrFeatureFrameSelection = {
  frames: PlaywrightPrFeatureFrame[];
  omittedCount: number;
};

export type PrChangedFile = { changes?: number; filename: string; patch?: string };

const SPEC_FILE_PATTERN = /^(.*)\.spec\.[cm]?[jt]sx?$/i;
const STRING_LITERAL = /(["'`])((?:\\.|(?!\1)[^\\])*)\1/g;
const CAPTURE_NAME = /^[a-z0-9][a-z0-9._-]*$/i;
const NAME_PART = /^[a-z0-9._-]{2,}$/i;

type TemplateName = { prefix: string; suffix: string };
type CaptureNames = { exact: Set<string>; templates: TemplateName[] };

// A checkpoint belongs to this PR only when the PR adds or edits the line naming it, as in
// captureScreenshot(page, testInfo, "billing-account-menu"). A template name matches by the
// literal text before its first and after its last placeholder.
function captureNamesFromPatch(patch: string): CaptureNames {
  const exact = new Set<string>();
  const templates: TemplateName[] = [];
  for (const line of patch.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    for (const [, quote, value = ""] of line.matchAll(STRING_LITERAL)) {
      const templateStart = quote === "`" ? value.indexOf("${") : -1;
      if (templateStart < 0) {
        const name = value.replace(/\.png$/i, "");
        if (CAPTURE_NAME.test(name)) exact.add(name.toLowerCase());
        continue;
      }
      const prefix = value.slice(0, templateStart).toLowerCase();
      const suffix = value
        .slice(value.lastIndexOf("}") + 1)
        .replace(/\.png$/i, "")
        .toLowerCase();
      const usable = (part: string) => NAME_PART.test(part);
      if (
        (usable(prefix) || usable(suffix)) &&
        (!prefix || usable(prefix)) &&
        (!suffix || usable(suffix))
      ) {
        templates.push({ prefix, suffix });
      }
    }
  }
  return { exact, templates };
}

function screenshotNamedByChange(source: string, names: CaptureNames): boolean {
  const name = (source.split(/[\\/]/).at(-1) ?? source).replace(/\.png$/i, "").toLowerCase();
  // A capture taller than one image continues in "<name>-2", "<name>-3" and so on.
  return (
    names.exact.has(name) ||
    names.exact.has(name.replace(/-\d+$/, "")) ||
    names.templates.some(({ prefix, suffix }) => name.startsWith(prefix) && name.endsWith(suffix))
  );
}

export function specStemsFromChangedPaths(changedPaths: readonly string[]): string[] {
  const stems = new Set<string>();
  for (const changedPath of changedPaths) {
    // Playwright names a test's output folder after its path inside the test folder, so a spec in
    // e2e/chat/ writes to "chat-<stem>-…".
    const segments = changedPath.split(/[\\/]/);
    const testDir = segments.lastIndexOf("e2e");
    const inTestDir = testDir < 0 ? segments.slice(-1) : segments.slice(testDir + 1);
    const match = SPEC_FILE_PATTERN.exec(inTestDir.join("-"));
    if (match?.[1]) stems.add(match[1].toLowerCase());
  }
  return [...stems].sort();
}

export function screenshotMatchesSpecStem(source: string, specStem: string): boolean {
  // Projects may nest output under their own folder, so use the test's directory, not the first segment.
  const directory = (source.split(/[\\/]/).at(-2) ?? source).toLowerCase();
  const stem = specStem.toLowerCase();
  return directory === stem || directory.startsWith(`${stem}-`);
}

export function selectPlaywrightPrFeatureFrames(input: {
  changedFiles: readonly PrChangedFile[];
  limit?: number;
  screenshots: readonly PlaywrightPrCommentScreenshot[];
}): PlaywrightPrFeatureFrameSelection {
  const limit = input.limit ?? PLAYWRIGHT_PR_FEATURE_FRAME_LIMIT;
  // GitHub leaves out the patch of a very large diff; then every checkpoint of that spec counts.
  // A rename with no edits has no patch either, and names nothing.
  const specs = input.changedFiles.flatMap((file) => {
    const stem = specStemsFromChangedPaths([file.filename])[0];
    return stem
      ? [
          {
            names:
              file.patch || !file.changes ? captureNamesFromPatch(file.patch ?? "") : undefined,
            stem,
          },
        ]
      : [];
  });
  // The main baseline can trail main by hours, so checkpoints other merged PRs added look new
  // and unrelated ones look changed. Only checkpoints this PR's diff names are about this PR.
  const checkpoints = input.screenshots.filter(
    (screenshot) =>
      screenshot.captureType === "checkpoint" &&
      specs.some(
        ({ names, stem }) =>
          screenshotMatchesSpecStem(screenshot.source, stem) &&
          (!names || screenshotNamedByChange(screenshot.source, names)),
      ),
  );
  const frames: PlaywrightPrFeatureFrame[] = [
    ...checkpoints
      .filter((screenshot) => screenshot.comparison === "new")
      .map((screenshot) => ({ ...screenshot, kind: "new" as const })),
    ...checkpoints
      .filter((screenshot) => screenshot.comparison === "changed")
      .map((screenshot) => ({ ...screenshot, kind: "changed" as const })),
  ];

  return {
    frames: frames.slice(0, limit),
    omittedCount: Math.max(0, frames.length - limit),
  };
}

export function buildPlaywrightPrScreenshotComment(input: {
  changedFiles: readonly PrChangedFile[];
  dashboardUrl: string;
  galleryUrl: string;
  limit?: number;
  runUrl: string;
  screenshots: readonly PlaywrightPrCommentScreenshot[];
  screenshotsUrl: string;
  sha: string;
}): string {
  const { frames, omittedCount } = selectPlaywrightPrFeatureFrames(input);
  const galleryBaseUrl = new URL(".", input.screenshotsUrl);
  const secondaryLinks = [
    `[Open screenshot gallery](${input.galleryUrl})`,
    `[Dashboard](${input.dashboardUrl})`,
    `[CI run](${input.runUrl})`,
  ].join(" · ");

  const featureSection =
    frames.length === 0
      ? "No new feature frames; gallery is suite-vs-main drift."
      : [
          "Feature frames for this PR:",
          ...frames.map((frame) => {
            const imageUrl = new URL(frame.fileName, galleryBaseUrl).toString();
            const label = escapeMarkdownLinkLabel(frame.title);
            return `**${label}** (${frame.kind})\n\n![${label}](${imageUrl})`;
          }),
          ...(omittedCount > 0 ? [`+${omittedCount} more in the gallery`] : []),
        ].join("\n\n");

  return [
    PLAYWRIGHT_PR_SCREENSHOT_COMMENT_MARKER,
    commitMarker.template.replace("{sha}", input.sha),
    "### Playwright screenshots",
    "",
    featureSection,
    "",
    secondaryLinks,
    "",
    `Updated for commit \`${input.sha.slice(0, 7)}\`.`,
  ].join("\n");
}

function escapeMarkdownLinkLabel(value: string): string {
  const normalized = value.replaceAll(/\s+/g, " ").trim();
  const label = normalized.length > 0 ? normalized : "screenshot";
  return label
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]")
    .replaceAll("`", "\\`")
    .replaceAll("*", "\\*")
    .replaceAll("_", "\\_")
    .replaceAll("#", "\\#");
}
