import { readFile } from "node:fs/promises";
import type {
  PlaywrightPrCommentScreenshot,
  PrChangedFile,
} from "./playwright-pr-screenshot-comment.js";
import { buildPlaywrightPrScreenshotComment } from "./playwright-pr-screenshot-comment.js";

const [reviewPath, changedFilesPath] = process.argv.slice(2);

if (!reviewPath || !changedFilesPath) {
  throw new Error(
    "Usage: build-playwright-pr-screenshot-comment <review-json-path> <changed-files-jsonl>",
  );
}

const review = JSON.parse(await readFile(reviewPath, "utf8")) as {
  screenshots?: PlaywrightPrCommentScreenshot[];
  screenshotsUrl?: string;
};
const changedFiles = (await readFile(changedFilesPath, "utf8"))
  .split(/\r?\n/)
  .filter((line) => line.trim())
  .map((line) => parseChangedFile(JSON.parse(line)));

if (!Array.isArray(review.screenshots)) {
  throw new Error("review.json must include a screenshots array");
}
if (
  typeof review.screenshotsUrl !== "string" ||
  !URL.canParse(review.screenshotsUrl) ||
  new URL(review.screenshotsUrl).protocol !== "https:"
) {
  throw new Error("review.json must include an https screenshotsUrl");
}

const galleryUrl = getRequiredHttpsEnvironmentVariable("PLAYWRIGHT_GALLERY_URL");
const dashboardUrl = getRequiredHttpsEnvironmentVariable("PLAYWRIGHT_DASHBOARD_URL");
const runUrl = getRequiredHttpsEnvironmentVariable("PLAYWRIGHT_RUN_URL");
const sha = getRequiredEnvironmentVariable("PLAYWRIGHT_SHA");

process.stdout.write(
  `${buildPlaywrightPrScreenshotComment({
    changedFiles,
    dashboardUrl,
    galleryUrl,
    runUrl,
    screenshots: review.screenshots,
    screenshotsUrl: review.screenshotsUrl,
    sha,
  })}\n`,
);

function parseChangedFile(value: unknown): PrChangedFile {
  const file = value as { changes?: unknown; filename?: unknown; patch?: unknown } | null;
  if (typeof file?.filename !== "string") {
    throw new Error("Each changed file needs a filename");
  }
  return {
    filename: file.filename,
    ...(typeof file.changes === "number" ? { changes: file.changes } : {}),
    ...(typeof file.patch === "string" ? { patch: file.patch } : {}),
  };
}

function getRequiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function getRequiredHttpsEnvironmentVariable(name: string): string {
  const value = getRequiredEnvironmentVariable(name);
  if (!URL.canParse(value) || new URL(value).protocol !== "https:") {
    throw new Error(`${name} must use HTTPS`);
  }
  return value;
}
