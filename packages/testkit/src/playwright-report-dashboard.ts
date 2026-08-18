const MAX_HISTORY_LENGTH = 100;
const SHARED_PAGE_STYLES = `
    :root { color-scheme: dark; font-family: Inter, ui-sans-serif, system-ui, sans-serif; background: #09090b; color: #fafafa; }
    * { box-sizing: border-box; }
    header { display: flex; align-items: end; justify-content: space-between; gap: 24px; margin-bottom: 32px; }
    h1 { margin: 0; font-size: clamp(2rem, 6vw, 4.5rem); letter-spacing: -0.06em; }
    .eyebrow { margin: 0 0 10px; color: #c4b5fd; font-size: 0.75rem; font-weight: 700; letter-spacing: 0.16em; text-transform: uppercase; }
    .subtitle { margin: 10px 0 0; color: #a1a1aa; }
    .actions { display: flex; flex-wrap: wrap; gap: 10px; }
    .button { display: inline-flex; align-items: center; min-height: 40px; padding: 0 16px; border: 1px solid #3f3f46; border-radius: 999px; color: #fafafa; text-decoration: none; background: rgba(24, 24, 27, 0.78); }
    .button:hover { border-color: #a78bfa; background: #2e1065; }
`;

export type PlaywrightRun = {
  attempt: number;
  branch: string;
  createdAt: string;
  event: string;
  id: string;
  reportUrl: string;
  result: string;
  runNumber: number;
  runUrl: string;
  screenshotCount: number;
  screenshotsUrl: string;
  sha: string;
};

export type PlaywrightScreenshot = {
  fileName: string;
  source: string;
  title: string;
};

export function updatePlaywrightHistory(
  existingHistory: unknown,
  run: PlaywrightRun,
): PlaywrightRun[] {
  const history = Array.isArray(existingHistory) ? existingHistory.filter(isPlaywrightRun) : [];

  return [
    run,
    ...history.filter(
      (previousRun) => previousRun.id !== run.id || previousRun.attempt !== run.attempt,
    ),
  ]
    .sort(compareRunRecency)
    .slice(0, MAX_HISTORY_LENGTH);
}

function compareRunRecency(left: PlaywrightRun, right: PlaywrightRun): number {
  const leftId = BigInt(left.id);
  const rightId = BigInt(right.id);
  if (leftId !== rightId) return leftId > rightId ? -1 : 1;
  return right.attempt - left.attempt;
}

export function renderPlaywrightDashboard(history: PlaywrightRun[]): string {
  const data = JSON.stringify(history).replaceAll("<", "\\u003c");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark" />
  <title>Playwright · Rakazo</title>
  <style>
    ${SHARED_PAGE_STYLES}
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top, #312e81 0, #09090b 34rem); }
    main { width: min(1120px, calc(100% - 32px)); margin: 0 auto; padding: 64px 0; }
    .summary { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; margin-bottom: 20px; }
    .card, .table-wrap { border: 1px solid rgba(113, 113, 122, 0.38); border-radius: 18px; background: rgba(9, 9, 11, 0.78); box-shadow: 0 24px 80px rgba(0, 0, 0, 0.28); backdrop-filter: blur(16px); }
    .card { padding: 20px; }
    .label { color: #a1a1aa; font-size: 0.72rem; font-weight: 700; letter-spacing: 0.12em; text-transform: uppercase; }
    .value { display: block; margin-top: 8px; font-size: 1.5rem; font-weight: 700; }
    .table-wrap { overflow: hidden; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 16px 18px; border-bottom: 1px solid rgba(63, 63, 70, 0.72); text-align: left; vertical-align: middle; }
    th { color: #a1a1aa; font-size: 0.7rem; letter-spacing: 0.1em; text-transform: uppercase; }
    tbody tr:last-child td { border-bottom: 0; }
    tbody tr:hover { background: rgba(46, 16, 101, 0.32); }
    .status { display: inline-flex; align-items: center; gap: 8px; font-weight: 700; text-transform: capitalize; }
    .status::before { width: 9px; height: 9px; border-radius: 50%; background: #f59e0b; content: ""; box-shadow: 0 0 18px currentColor; }
    .status.success { color: #4ade80; }
    .status.success::before { background: #4ade80; }
    .status.failure, .status.cancelled { color: #fb7185; }
    .status.failure::before, .status.cancelled::before { background: #fb7185; }
    .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
    .links { display: flex; gap: 14px; white-space: nowrap; }
    .links a { color: #c4b5fd; text-decoration: none; }
    .links a:hover { text-decoration: underline; }
    .empty { padding: 56px 24px; color: #a1a1aa; text-align: center; }
    footer { margin-top: 18px; color: #71717a; font-size: 0.8rem; text-align: right; }
    @media (max-width: 760px) {
      main { padding: 36px 0; }
      header { align-items: start; flex-direction: column; }
      .summary { grid-template-columns: repeat(2, minmax(0, 1fr)); }
      .table-wrap { overflow-x: auto; }
      table { min-width: 880px; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <p class="eyebrow">Rakazo · browser checks</p>
        <h1>Playwright</h1>
        <p class="subtitle">Persistent visual evidence and results from the emulated end-to-end suite.</p>
      </div>
      <div class="actions">
        <a class="button" href="#" id="latest-screenshots">Latest screenshots</a>
        <a class="button" href="#" id="latest-report">Latest report</a>
        <a class="button" href="https://github.com/elie222/rakazo/actions">GitHub Actions</a>
      </div>
    </header>

    <section class="summary" id="summary"></section>
    <section class="table-wrap">
      <table>
        <thead>
          <tr><th>Result</th><th>Run</th><th>Commit</th><th>Trigger</th><th>Screenshots</th><th>Published</th><th>Links</th></tr>
        </thead>
        <tbody id="runs"></tbody>
      </table>
      <div class="empty" id="empty" hidden>No Playwright runs have been published yet.</div>
    </section>
    <footer id="generated-at"></footer>
  </main>
  <script>
    const history = ${data};
    const runs = document.querySelector("#runs");
    const empty = document.querySelector("#empty");
    const summary = document.querySelector("#summary");
    const generatedAt = document.querySelector("#generated-at");
    const latestReport = document.querySelector("#latest-report");
    const latestScreenshots = document.querySelector("#latest-screenshots");

    if (history.length === 0) {
      empty.hidden = false;
      latestReport.hidden = true;
      latestScreenshots.hidden = true;
    } else {
      latestReport.href = history[0].reportUrl;
      latestScreenshots.href = history[0].screenshotsUrl;
    }

    const latest = history[0];
    const recent = history.slice(0, 10);
    const recentPassing = recent.filter((run) => run.result === "success").length;
    const cards = [
      ["Latest result", latest?.result ?? "No runs"],
      ["Latest screenshots", latest ? String(latest.screenshotCount) : "—"],
      ["Recent pass rate", recent.length ? Math.round((recentPassing / recent.length) * 100) + "%" : "—"],
      ["Stored runs", String(history.length)],
    ];

    for (const [label, value] of cards) {
      const card = document.createElement("article");
      card.className = "card";
      const labelElement = document.createElement("span");
      labelElement.className = "label";
      labelElement.textContent = label;
      const valueElement = document.createElement("span");
      valueElement.className = "value";
      valueElement.textContent = value;
      card.append(labelElement, valueElement);
      summary.append(card);
    }

    for (const run of history) {
      const row = document.createElement("tr");
      const result = document.createElement("td");
      const status = document.createElement("span");
      const knownStatus = ["success", "failure", "cancelled"].includes(run.result) ? run.result : "other";
      status.className = "status " + knownStatus;
      status.textContent = run.result;
      result.append(status);

      const runNumber = document.createElement("td");
      runNumber.textContent = "#" + run.runNumber + " · attempt " + run.attempt;
      const commit = document.createElement("td");
      commit.className = "mono";
      commit.textContent = run.sha.slice(0, 7);
      const event = document.createElement("td");
      event.textContent = run.event + " · " + run.branch;
      const screenshotCount = document.createElement("td");
      screenshotCount.textContent = String(run.screenshotCount);
      const published = document.createElement("td");
      published.textContent = new Date(run.createdAt).toLocaleString();
      const links = document.createElement("td");
      const linkList = document.createElement("div");
      linkList.className = "links";
      const screenshots = document.createElement("a");
      screenshots.href = run.screenshotsUrl;
      screenshots.textContent = "Screenshots";
      const report = document.createElement("a");
      report.href = run.reportUrl;
      report.textContent = "Report";
      const actions = document.createElement("a");
      actions.href = run.runUrl;
      actions.textContent = "Actions";
      linkList.append(screenshots, report, actions);
      links.append(linkList);

      row.append(result, runNumber, commit, event, screenshotCount, published, links);
      runs.append(row);
    }

    generatedAt.textContent = latest
      ? "Latest result published " + new Date(latest.createdAt).toLocaleString()
      : "Waiting for the first published run";
  </script>
</body>
</html>`;
}

export function renderScreenshotGallery(input: {
  createdAt: string;
  dashboardUrl: string;
  reportUrl: string;
  result: string;
  runUrl: string;
  screenshots: PlaywrightScreenshot[];
  sha: string;
}): string {
  const screenshots = input.screenshots
    .map(
      (screenshot, index) => `
        <figure>
          <a href="${escapeHtml(screenshot.fileName)}" target="_blank" rel="noreferrer">
            <img src="${escapeHtml(screenshot.fileName)}" alt="${escapeHtml(screenshot.title)}" loading="lazy" />
          </a>
          <figcaption>
            <span class="number">${String(index + 1).padStart(2, "0")}</span>
            <span><strong>${escapeHtml(screenshot.title)}</strong><small>${escapeHtml(screenshot.source)}</small></span>
          </figcaption>
        </figure>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="dark" />
  <title>Run screenshots · Rakazo</title>
  <style>
    ${SHARED_PAGE_STYLES}
    body { margin: 0; min-height: 100vh; background: radial-gradient(circle at top, #312e81 0, #09090b 36rem); }
    main { width: min(1440px, calc(100% - 32px)); margin: 0 auto; padding: 56px 0 80px; }
    header { margin-bottom: 30px; }
    .toolbar { display: flex; align-items: center; justify-content: space-between; gap: 16px; margin-bottom: 28px; }
    .meta { display: flex; flex-wrap: wrap; gap: 10px; }
    .pill { padding: 8px 12px; border: 1px solid rgba(113, 113, 122, 0.45); border-radius: 999px; color: #d4d4d8; background: rgba(9, 9, 11, 0.7); }
    .view-options { display: inline-flex; flex: 0 0 auto; gap: 4px; padding: 4px; border: 1px solid rgba(113, 113, 122, 0.45); border-radius: 10px; background: rgba(9, 9, 11, 0.7); }
    .view-option { display: grid; width: 34px; height: 34px; padding: 0; border: 0; border-radius: 7px; place-items: center; color: #a1a1aa; background: transparent; cursor: pointer; }
    .view-option:hover { color: #fafafa; background: rgba(63, 63, 70, 0.72); }
    .view-option[aria-pressed="true"] { color: #fafafa; background: #5b21b6; }
    .view-option:focus-visible { outline: 2px solid #c4b5fd; outline-offset: 2px; }
    .view-option svg { width: 18px; height: 18px; }
    .gallery { display: grid; grid-template-columns: repeat(var(--gallery-columns, 1), minmax(0, 1fr)); gap: 22px; }
    figure { margin: 0; overflow: hidden; border: 1px solid rgba(113, 113, 122, 0.42); border-radius: 18px; background: rgba(9, 9, 11, 0.84); box-shadow: 0 24px 80px rgba(0, 0, 0, 0.28); }
    figure > a { display: grid; min-height: 300px; place-items: center; padding: 12px; background: #18181b; }
    img { display: block; width: 100%; max-height: 820px; object-fit: contain; object-position: top; border-radius: 10px; }
    figcaption { display: flex; align-items: center; gap: 14px; padding: 16px 18px; border-top: 1px solid rgba(63, 63, 70, 0.72); }
    figcaption span:last-child { min-width: 0; }
    figcaption strong, figcaption small { display: block; }
    figcaption strong { text-transform: capitalize; }
    figcaption small { margin-top: 4px; overflow: hidden; color: #71717a; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; text-overflow: ellipsis; white-space: nowrap; }
    .number { display: grid; width: 36px; height: 36px; flex: 0 0 auto; place-items: center; border-radius: 50%; color: #ddd6fe; background: #2e1065; font-size: 0.78rem; font-weight: 700; }
    .empty { padding: 80px 24px; border: 1px solid rgba(113, 113, 122, 0.38); border-radius: 18px; color: #a1a1aa; text-align: center; background: rgba(9, 9, 11, 0.78); }
    @media (max-width: 900px) {
      header { align-items: start; flex-direction: column; }
      .toolbar { align-items: start; flex-direction: column; }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <div>
        <p class="eyebrow">Rakazo · visual review</p>
        <h1>Run screenshots</h1>
        <p class="subtitle">Scan every captured product state from this Playwright run.</p>
      </div>
      <div class="actions">
        <a class="button" href="${escapeHtml(input.reportUrl)}">Full report</a>
        <a class="button" href="${escapeHtml(input.runUrl)}">GitHub Actions</a>
        <a class="button" href="${escapeHtml(input.dashboardUrl)}">All runs</a>
      </div>
    </header>
    <div class="toolbar">
      <section class="meta">
        <span class="pill">${escapeHtml(input.result)}</span>
        <span class="pill">${escapeHtml(input.sha.slice(0, 7))}</span>
        <span class="pill">${input.screenshots.length} screenshots</span>
        <span class="pill">${escapeHtml(new Date(input.createdAt).toLocaleString("en-US", { timeZone: "UTC" }))} UTC</span>
      </section>
      ${
        screenshots
          ? `<div class="view-options" role="group" aria-label="Gallery columns">
        <button class="view-option" type="button" data-columns="1" aria-label="One column" aria-pressed="true" title="One column">
          <svg aria-hidden="true" viewBox="0 0 18 18"><rect x="3" y="2" width="12" height="14" rx="1.5" fill="currentColor" /></svg>
        </button>
        <button class="view-option" type="button" data-columns="2" aria-label="Two columns" aria-pressed="false" title="Two columns">
          <svg aria-hidden="true" viewBox="0 0 18 18"><rect x="1" y="2" width="7" height="14" rx="1.5" fill="currentColor" /><rect x="10" y="2" width="7" height="14" rx="1.5" fill="currentColor" /></svg>
        </button>
        <button class="view-option" type="button" data-columns="3" aria-label="Three columns" aria-pressed="false" title="Three columns">
          <svg aria-hidden="true" viewBox="0 0 18 18"><rect x="1" y="2" width="4" height="14" rx="1" fill="currentColor" /><rect x="7" y="2" width="4" height="14" rx="1" fill="currentColor" /><rect x="13" y="2" width="4" height="14" rx="1" fill="currentColor" /></svg>
        </button>
        <button class="view-option" type="button" data-columns="4" aria-label="Four columns" aria-pressed="false" title="Four columns">
          <svg aria-hidden="true" viewBox="0 0 18 18"><rect x="1" y="2" width="3" height="14" rx="1" fill="currentColor" /><rect x="5.3" y="2" width="3" height="14" rx="1" fill="currentColor" /><rect x="9.7" y="2" width="3" height="14" rx="1" fill="currentColor" /><rect x="14" y="2" width="3" height="14" rx="1" fill="currentColor" /></svg>
        </button>
      </div>`
          : ""
      }
    </div>
    ${screenshots ? `<section class="gallery">${screenshots}</section>` : '<div class="empty">No screenshots were produced by this run.</div>'}
  </main>
  <script>
    const gallery = document.querySelector(".gallery");
    const viewOptions = Array.from(document.querySelectorAll(".view-option"));
    const storageKey = "rakazo-playwright-gallery-columns";

    function setGalleryColumns(value, persist = false) {
      if (!gallery || !["1", "2", "3", "4"].includes(value)) return;

      gallery.style.setProperty("--gallery-columns", value);
      for (const option of viewOptions) {
        option.setAttribute("aria-pressed", String(option.dataset.columns === value));
      }

      if (persist) {
        try {
          localStorage.setItem(storageKey, value);
        } catch {}
      }
    }

    let initialColumns = "1";
    try {
      initialColumns = localStorage.getItem(storageKey) || initialColumns;
    } catch {}
    setGalleryColumns(initialColumns);

    for (const option of viewOptions) {
      option.addEventListener("click", () => setGalleryColumns(option.dataset.columns, true));
    }
  </script>
</body>
</html>`;
}

function isPlaywrightRun(value: unknown): value is PlaywrightRun {
  if (!value || typeof value !== "object") return false;

  const run = value as Partial<PlaywrightRun>;
  return (
    typeof run.attempt === "number" &&
    typeof run.branch === "string" &&
    typeof run.createdAt === "string" &&
    typeof run.event === "string" &&
    typeof run.id === "string" &&
    /^\d+$/.test(run.id) &&
    isHttpsUrl(run.reportUrl) &&
    typeof run.result === "string" &&
    typeof run.runNumber === "number" &&
    isHttpsUrl(run.runUrl) &&
    typeof run.screenshotCount === "number" &&
    isHttpsUrl(run.screenshotsUrl) &&
    typeof run.sha === "string"
  );
}

function isHttpsUrl(value: unknown): value is string {
  return typeof value === "string" && URL.canParse(value) && new URL(value).protocol === "https:";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}
