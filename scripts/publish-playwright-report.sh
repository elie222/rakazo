#!/usr/bin/env bash
set -euo pipefail

: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
: "${S3_ENDPOINT:?S3_ENDPOINT is required}"
: "${PLAYWRIGHT_PUBLIC_BASE_URL:?PLAYWRIGHT_PUBLIC_BASE_URL is required}"
: "${PLAYWRIGHT_RESULT:?PLAYWRIGHT_RESULT is required}"
: "${PLAYWRIGHT_RUN_ATTEMPT:?PLAYWRIGHT_RUN_ATTEMPT is required}"
: "${PLAYWRIGHT_RUN_ID:?PLAYWRIGHT_RUN_ID is required}"
: "${PLAYWRIGHT_RUN_NUMBER:?PLAYWRIGHT_RUN_NUMBER is required}"
: "${PLAYWRIGHT_RUN_URL:?PLAYWRIGHT_RUN_URL is required}"
: "${PLAYWRIGHT_SHA:?PLAYWRIGHT_SHA is required}"
: "${PLAYWRIGHT_EVENT:?PLAYWRIGHT_EVENT is required}"
: "${PLAYWRIGHT_BRANCH:?PLAYWRIGHT_BRANCH is required}"

report_dir="${PLAYWRIGHT_REPORT_DIR:-playwright-report}"
test_results_dir="${PLAYWRIGHT_TEST_RESULTS_DIR:-apps/web/test-results}"
publish_report="${PLAYWRIGHT_PUBLISH_REPORT:-true}"

if [[ "$publish_report" != "true" && "$publish_report" != "false" ]]; then
  echo "PLAYWRIGHT_PUBLISH_REPORT must be true or false." >&2
  exit 1
fi

if [[ "$publish_report" == "true" && ! -f "$report_dir/index.html" ]]; then
  echo "::warning::Playwright did not produce an HTML report; publishing the gallery and dashboard entry without it."
  publish_report="false"
fi

if [[ ! "$S3_BUCKET" =~ ^[a-zA-Z0-9.-]+$ ]]; then
  echo "S3_BUCKET contains invalid characters." >&2
  exit 1
fi

case "$S3_ENDPOINT" in
  https://*) ;;
  *) echo "S3_ENDPOINT must use HTTPS." >&2; exit 1 ;;
esac

case "$PLAYWRIGHT_PUBLIC_BASE_URL" in
  https://*) ;;
  *) echo "PLAYWRIGHT_PUBLIC_BASE_URL must use HTTPS." >&2; exit 1 ;;
esac

dashboard_dir="$GITHUB_WORKSPACE/.tmp/playwright-dashboard"
history_path="$dashboard_dir/history.json"
dashboard_path="$dashboard_dir/index.html"
gallery_dir="$dashboard_dir/screenshots"
history_error_path="$dashboard_dir/history-download-error.log"
run_key="${PLAYWRIGHT_RUN_ID}-${PLAYWRIGHT_RUN_ATTEMPT}"
bucket_uri="s3://${S3_BUCKET}/playwright"
public_base_url="${PLAYWRIGHT_PUBLIC_BASE_URL%/}"
report_url="$public_base_url/runs/$run_key/report/index.html"
screenshots_url="$public_base_url/runs/$run_key/screenshots/index.html"
pull_request_url=""

if [[ -n "${PLAYWRIGHT_PR_NUMBER:-}" ]]; then
  if [[ ! "$PLAYWRIGHT_PR_NUMBER" =~ ^[1-9][0-9]*$ ]]; then
    echo "PLAYWRIGHT_PR_NUMBER must be a positive integer." >&2
    exit 1
  fi
  : "${PLAYWRIGHT_REPOSITORY_URL:?PLAYWRIGHT_REPOSITORY_URL is required for pull request runs}"
  case "$PLAYWRIGHT_REPOSITORY_URL" in
    https://*) ;;
    *) echo "PLAYWRIGHT_REPOSITORY_URL must use HTTPS." >&2; exit 1 ;;
  esac
  pull_request_url="${PLAYWRIGHT_REPOSITORY_URL%/}/pull/$PLAYWRIGHT_PR_NUMBER"
fi

if [[ "$publish_report" == "false" ]]; then
  report_url=""
fi

mkdir -p "$dashboard_dir"
if aws s3 cp \
  "$bucket_uri/history.json" \
  "$history_path" \
  --endpoint-url "$S3_ENDPOINT" \
  2>"$history_error_path"; then
  echo "Downloaded existing Playwright history."
elif grep -Eq "404|NoSuchKey|Not Found" "$history_error_path"; then
  echo "No existing Playwright history found; creating it."
else
  cat "$history_error_path"
  exit 1
fi

PLAYWRIGHT_REPORT_URL="$report_url" \
PLAYWRIGHT_SCREENSHOTS_URL="$screenshots_url" \
PLAYWRIGHT_DASHBOARD_URL="$public_base_url/index.html" \
PLAYWRIGHT_PR_URL="$pull_request_url" \
  pnpm exec tsx \
    packages/testkit/src/cli/generate-playwright-report-dashboard.ts \
    "$history_path" \
    "$dashboard_path" \
    "$test_results_dir" \
    "$gallery_dir"

if [[ "$publish_report" == "true" ]]; then
  aws s3 sync \
    "$report_dir/" \
    "$bucket_uri/runs/$run_key/report/" \
    --endpoint-url "$S3_ENDPOINT" \
    --cache-control "public,max-age=31536000,immutable"
fi
aws s3 sync \
  "$gallery_dir/images/" \
  "$bucket_uri/runs/$run_key/screenshots/images/" \
  --endpoint-url "$S3_ENDPOINT" \
  --content-type "image/png" \
  --no-guess-mime-type \
  --cache-control "public,max-age=31536000,immutable"
aws s3 cp \
  "$gallery_dir/index.html" \
  "$bucket_uri/runs/$run_key/screenshots/index.html" \
  --endpoint-url "$S3_ENDPOINT" \
  --content-type "text/html" \
  --cache-control "public,max-age=31536000,immutable"
aws s3 cp \
  "$history_path" \
  "$bucket_uri/history.json" \
  --endpoint-url "$S3_ENDPOINT" \
  --content-type "application/json" \
  --cache-control "no-store"
aws s3 cp \
  "$dashboard_path" \
  "$bucket_uri/index.html" \
  --endpoint-url "$S3_ENDPOINT" \
  --content-type "text/html" \
  --cache-control "no-store"

summary=$(cat <<EOF
### Playwright visual report
- [Screenshot gallery]($screenshots_url)
- [Dashboard]($public_base_url/index.html)
EOF
)

if [[ -n "$report_url" ]]; then
  summary="$summary
- [Full report]($report_url)"
fi
if [[ -n "$pull_request_url" ]]; then
  summary="$summary
- [Pull request]($pull_request_url)"
fi

if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  printf '%s\n' "$summary" >> "$GITHUB_STEP_SUMMARY"
else
  printf '%s\n' "$summary"
fi
