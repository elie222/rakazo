import { readFile, writeFile } from "node:fs/promises";
import {
  isPlaywrightRun,
  renderPlaywrightDashboard,
  updatePlaywrightHistory,
} from "./playwright-report-dashboard.js";

const [historyPath, historyEntryPath, dashboardPath] = process.argv.slice(2);

if (!historyPath || !historyEntryPath || !dashboardPath) {
  throw new Error(
    "Usage: update-playwright-history <history-path> <history-entry-path> <dashboard-path>",
  );
}

const entry: unknown = JSON.parse(await readFile(historyEntryPath, "utf8"));
if (!isPlaywrightRun(entry)) {
  throw new Error("The Playwright history entry is invalid");
}
const history = updatePlaywrightHistory(await readHistory(historyPath), entry);
await writeFile(historyPath, `${JSON.stringify(history, null, 2)}\n`);
await writeFile(dashboardPath, renderPlaywrightDashboard(history));
console.log(`Playwright dashboard updated with ${history.length} runs.`);

async function readHistory(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}
