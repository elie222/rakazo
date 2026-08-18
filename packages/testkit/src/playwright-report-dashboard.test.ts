import { describe, expect, it } from "vitest";
import {
  type PlaywrightRun,
  renderPlaywrightDashboard,
  renderScreenshotGallery,
  updatePlaywrightHistory,
} from "./playwright-report-dashboard.js";

describe("updatePlaywrightHistory", () => {
  it("places the current attempt first and replaces an existing copy", () => {
    const previousRun = getRun({ id: "100", runNumber: 8 });
    const currentRun = getRun({ id: "200", runNumber: 9 });
    const existingCurrentRun = getRun({
      id: currentRun.id,
      reportUrl: "https://example.com/old-report",
      runNumber: currentRun.runNumber,
    });

    expect(updatePlaywrightHistory([previousRun, existingCurrentRun], currentRun)).toEqual([
      currentRun,
      previousRun,
    ]);
  });

  it("keeps the latest 100 valid runs", () => {
    const previousRuns = Array.from({ length: 105 }, (_, index) =>
      getRun({ id: String(index), runNumber: index }),
    );

    const history = updatePlaywrightHistory(previousRuns, getRun());

    expect(history).toHaveLength(100);
    expect(history[0]?.id).toBe("200");
    expect(history.at(-1)?.id).toBe("6");
  });

  it("keeps a delayed older run behind the newest run", () => {
    const newestRun = getRun({ id: "300", runNumber: 11 });
    const delayedRun = getRun({ id: "250", runNumber: 10 });

    expect(updatePlaywrightHistory([newestRun], delayedRun)).toEqual([newestRun, delayedRun]);
  });

  it("orders rerun attempts from newest to oldest", () => {
    const firstAttempt = getRun({ attempt: 1 });
    const secondAttempt = getRun({ attempt: 2 });

    expect(updatePlaywrightHistory([secondAttempt], firstAttempt)).toEqual([
      secondAttempt,
      firstAttempt,
    ]);
  });

  it("drops malformed and unsafe history entries", () => {
    const currentRun = getRun();

    expect(
      updatePlaywrightHistory(
        [null, { id: "broken" }, getRun({ reportUrl: "javascript:alert(1)" })],
        currentRun,
      ),
    ).toEqual([currentRun]);
  });

  it("keeps screenshot-only pull request runs", () => {
    const pullRequestRun = getRun({
      branch: "external-contributor-branch",
      event: "pull_request",
      pullRequestNumber: 59,
      pullRequestUrl: "https://github.com/example/repository/pull/59",
      reportUrl: undefined,
    });

    expect(updatePlaywrightHistory([], pullRequestRun)).toEqual([pullRequestRun]);
  });
});

describe("renderPlaywrightDashboard", () => {
  it("embeds run history without allowing a script breakout", () => {
    const html = renderPlaywrightDashboard([
      getRun({ branch: "</script><script>alert(1)</script>" }),
    ]);

    expect(html).not.toContain("</script><script>alert(1)</script>");
    expect(html).toContain("\\u003c/script>\\u003cscript>alert(1)\\u003c/script>");
    expect(html).toContain("latestReport.href = latestWithReport.reportUrl");
    expect(html).toContain("latestScreenshots.href = history[0].screenshotsUrl");
  });
});

describe("renderScreenshotGallery", () => {
  it("renders scan-friendly images and escapes labels", () => {
    const html = renderScreenshotGallery({
      createdAt: "2026-08-16T10:00:00.000Z",
      dashboardUrl: "https://example.com/playwright/index.html",
      reportUrl: "https://example.com/report",
      result: "success",
      runUrl: "https://github.com/example/repository/actions/runs/200",
      screenshots: [
        {
          fileName: "images/001-shell.png",
          source: "golden/<script>.png",
          title: "main <script>alert(1)</script>",
        },
      ],
      sha: "abcdef1234567890",
    });

    expect(html).toContain('src="images/001-shell.png"');
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("main &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain("repeat(var(--gallery-columns, 1), minmax(0, 1fr))");
    expect(html).toContain('data-columns="1" aria-label="One column" aria-pressed="true"');
    expect(html).toContain('data-columns="4" aria-label="Four columns" aria-pressed="false"');
    expect(html).toContain("initialColumns = localStorage.getItem(storageKey) || initialColumns");
    expect(html).toContain(`@media (max-width: 900px) {
      header { align-items: start; flex-direction: column; }
      .toolbar { align-items: start; flex-direction: column; }
      .view-options { display: none; }
      .gallery { grid-template-columns: 1fr; }
    }`);
  });

  it("links a pull request without exposing an untrusted HTML report", () => {
    const html = renderScreenshotGallery({
      createdAt: "2026-08-16T10:00:00.000Z",
      dashboardUrl: "https://example.com/playwright/index.html",
      pullRequestNumber: 59,
      pullRequestUrl: "https://github.com/example/repository/pull/59",
      result: "success",
      runUrl: "https://github.com/example/repository/actions/runs/200",
      screenshots: [],
      sha: "abcdef1234567890",
    });

    expect(html).toContain('href="https://github.com/example/repository/pull/59">PR #59</a>');
    expect(html).not.toContain("Full report");
  });
});

function getRun(overrides: Partial<PlaywrightRun> = {}): PlaywrightRun {
  return {
    attempt: 1,
    branch: "main",
    createdAt: "2026-08-16T10:00:00.000Z",
    event: "push",
    id: "200",
    reportUrl: "https://example.com/playwright/runs/200-1/report/index.html",
    result: "success",
    runNumber: 10,
    runUrl: "https://github.com/example/repository/actions/runs/200",
    screenshotCount: 12,
    screenshotsUrl: "https://example.com/playwright/runs/200-1/screenshots/index.html",
    sha: "abcdef1234567890",
    ...overrides,
  };
}
