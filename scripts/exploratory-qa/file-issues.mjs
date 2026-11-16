#!/usr/bin/env node
// Files one GitHub issue per new bug in the explorer's findings, skipping any whose fingerprint
// an open exploratory-qa issue already carries. Also lists those issues for the explorer (--list).
import { readFileSync, writeFileSync } from "node:fs";
import { ISSUE_LABEL, issueBody, issueTitle, planIssues } from "./qa-lib.mjs";

const { GITHUB_TOKEN, GITHUB_REPOSITORY, RUN_URL, ARTIFACT_URL } = process.env;
if (!GITHUB_TOKEN || !GITHUB_REPOSITORY)
  throw new Error("GITHUB_TOKEN and GITHUB_REPOSITORY are required");
const api = `https://api.github.com/repos/${GITHUB_REPOSITORY}`;

async function github(path, init = {}) {
  const response = await fetch(`${api}${path}`, {
    ...init,
    headers: {
      accept: "application/vnd.github+json",
      authorization: `Bearer ${GITHUB_TOKEN}`,
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    },
  });
  return response;
}

async function openQaIssues() {
  const issues = [];
  for (let page = 1; ; page += 1) {
    const response = await github(
      `/issues?state=open&labels=${ISSUE_LABEL}&per_page=100&page=${page}`,
    );
    if (!response.ok) throw new Error(`Listing issues failed with status ${response.status}`);
    const batch = await response.json();
    issues.push(
      ...batch.filter((i) => !i.pull_request).map((i) => ({ title: i.title, body: i.body })),
    );
    if (batch.length < 100) break;
  }
  return issues;
}

const [command, path] = process.argv.slice(2);
if (command === "--list") {
  writeFileSync(path, `${JSON.stringify(await openQaIssues())}\n`);
} else if (command === "--file") {
  const findings = JSON.parse(readFileSync(path, "utf8"));
  const planned = planIssues(findings, await openQaIssues());
  if (planned.length > 0) {
    const label = await github("/labels", {
      method: "POST",
      body: JSON.stringify({
        name: ISSUE_LABEL,
        color: "ededed",
        description: "Found by the weekly exploratory QA agent",
      }),
    });
    if (!label.ok && label.status !== 422)
      throw new Error(`Creating the label failed with status ${label.status}`);
  }
  const links = { runUrl: RUN_URL, artifactUrl: ARTIFACT_URL || undefined };
  for (const finding of planned) {
    const response = await github("/issues", {
      method: "POST",
      body: JSON.stringify({
        title: issueTitle(finding),
        body: issueBody(finding, links),
        labels: [ISSUE_LABEL],
      }),
    });
    if (!response.ok) throw new Error(`Filing an issue failed with status ${response.status}`);
    console.log(`Filed ${(await response.json()).html_url}`);
  }
  console.log(`${findings.length} findings, ${planned.length} new issues.`);
} else {
  throw new Error("Usage: file-issues.mjs --list <out.json> | --file <findings.json>");
}
