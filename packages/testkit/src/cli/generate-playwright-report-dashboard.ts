import type { Dirent } from "node:fs";
import { copyFile, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  type PlaywrightScreenshot,
  renderPlaywrightDashboard,
  renderScreenshotGallery,
  updatePlaywrightHistory,
} from "../playwright-report-dashboard.js";

const [historyPath, dashboardPath, testResultsPath, galleryPath] = process.argv.slice(2);

if (!historyPath || !dashboardPath || !testResultsPath || !galleryPath) {
  throw new Error(
    "Usage: generate-playwright-report-dashboard <history-path> <dashboard-path> <test-results-path> <gallery-path>",
  );
}

const screenshots = await collectScreenshots(testResultsPath, galleryPath);
const createdAt = new Date().toISOString();
const dashboardUrl = getRequiredEnvironmentVariable("PLAYWRIGHT_DASHBOARD_URL");
const reportUrl = getRequiredEnvironmentVariable("PLAYWRIGHT_REPORT_URL");
const screenshotsUrl = getRequiredEnvironmentVariable("PLAYWRIGHT_SCREENSHOTS_URL");
const result = getRequiredEnvironmentVariable("PLAYWRIGHT_RESULT");
const runUrl = getRequiredEnvironmentVariable("PLAYWRIGHT_RUN_URL");
const sha = getRequiredEnvironmentVariable("PLAYWRIGHT_SHA");
const existingHistory = await readHistory(historyPath);
const history = updatePlaywrightHistory(existingHistory, {
  attempt: getRequiredNumber("PLAYWRIGHT_RUN_ATTEMPT"),
  branch: getRequiredEnvironmentVariable("PLAYWRIGHT_BRANCH"),
  createdAt,
  event: getRequiredEnvironmentVariable("PLAYWRIGHT_EVENT"),
  id: getRequiredEnvironmentVariable("PLAYWRIGHT_RUN_ID"),
  reportUrl,
  result,
  runNumber: getRequiredNumber("PLAYWRIGHT_RUN_NUMBER"),
  runUrl,
  screenshotCount: screenshots.length,
  screenshotsUrl,
  sha,
});

await mkdir(path.dirname(historyPath), { recursive: true });
await mkdir(path.dirname(dashboardPath), { recursive: true });
await mkdir(galleryPath, { recursive: true });
await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`);
await writeFile(dashboardPath, renderPlaywrightDashboard(history));
await writeFile(
  path.join(galleryPath, "index.html"),
  renderScreenshotGallery({
    createdAt,
    dashboardUrl,
    reportUrl,
    result,
    runUrl,
    screenshots,
    sha,
  }),
);

console.log(
  `Playwright dashboard generated with ${history.length} runs and ${screenshots.length} screenshots.`,
);

async function collectScreenshots(
  resultsPath: string,
  outputPath: string,
): Promise<PlaywrightScreenshot[]> {
  const files = (await findPngFiles(resultsPath)).sort((left, right) =>
    path.basename(left).localeCompare(path.basename(right)),
  );
  const imagePath = path.join(outputPath, "images");
  await mkdir(imagePath, { recursive: true });

  return Promise.all(
    files.map(async (file, index) => {
      const source = path.relative(resultsPath, file);
      const fileName = `${String(index + 1).padStart(3, "0")}-${sanitizeFileName(path.basename(file))}`;
      await copyFile(file, path.join(imagePath, fileName));
      return {
        fileName: `images/${fileName}`,
        source,
        title: titleFromFileName(path.basename(file)),
      };
    }),
  );
}

async function findPngFiles(directory: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }

  const files = await Promise.all(
    entries.map(async (entry) => {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory() && entry.name === "attachments") return [];
      if (entry.isDirectory()) return findPngFiles(entryPath);
      return entry.isFile() && entry.name.toLowerCase().endsWith(".png") ? [entryPath] : [];
    }),
  );
  return files.flat();
}

function sanitizeFileName(fileName: string): string {
  return fileName.replaceAll(/[^a-zA-Z0-9._-]/g, "-");
}

function titleFromFileName(fileName: string): string {
  return fileName
    .replace(/\.png$/i, "")
    .replace(/^\d+-/, "")
    .replaceAll(/[-_]+/g, " ");
}

function getRequiredEnvironmentVariable(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function getRequiredNumber(name: string): number {
  const value = Number(getRequiredEnvironmentVariable(name));
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number`);
  return value;
}

async function readHistory(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (isNodeError(error) && error.code === "ENOENT") return [];
    throw error;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
