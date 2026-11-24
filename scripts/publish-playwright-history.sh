#!/usr/bin/env bash
# Adds one run to the shared Playwright history and dashboard. Callers serialize
# this read-modify-write; everything else a run publishes lives under its own key.
set -euo pipefail

: "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required}"
: "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required}"
: "${S3_BUCKET:?S3_BUCKET is required}"
: "${S3_ENDPOINT:?S3_ENDPOINT is required}"

entry_path="${1:?Usage: publish-playwright-history.sh <history-entry-path>}"

if [[ ! "$S3_BUCKET" =~ ^[a-zA-Z0-9.-]+$ ]]; then
  echo "S3_BUCKET contains invalid characters." >&2
  exit 1
fi

case "$S3_ENDPOINT" in
  https://*) ;;
  *) echo "S3_ENDPOINT must use HTTPS." >&2; exit 1 ;;
esac

work_dir="$(mktemp -d)"
trap 'rm -rf "$work_dir"' EXIT
history_path="$work_dir/history.json"
dashboard_path="$work_dir/index.html"
bucket_uri="s3://${S3_BUCKET}/playwright"

if aws s3 cp \
  "$bucket_uri/history.json" \
  "$history_path" \
  --endpoint-url "$S3_ENDPOINT" \
  2>"$work_dir/download-error.log"; then
  echo "Downloaded existing Playwright history."
elif grep -Eq "404|NoSuchKey|Not Found" "$work_dir/download-error.log"; then
  echo "No existing Playwright history found; creating it."
else
  cat "$work_dir/download-error.log"
  exit 1
fi

pnpm exec tsx \
  packages/testkit/src/screenshots/update-playwright-history.ts \
  "$history_path" \
  "$entry_path" \
  "$dashboard_path"

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
