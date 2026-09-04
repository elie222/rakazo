#!/usr/bin/env bash
set -euo pipefail

report_dir="test-report/mobile-screenshots"
metro_log="${RUNNER_TEMP:?}/rakazo-mobile-metro.log"
run_log="${RUNNER_TEMP:?}/rakazo-mobile-screenshots.log"
metro_pid=""

mkdir -p "$report_dir"
exec > >(tee "$run_log") 2>&1

cleanup() {
  if [[ -n "$metro_pid" ]]; then
    kill "$metro_pid" 2>/dev/null || true
  fi
  cp "$run_log" "$report_dir/run.log" 2>/dev/null || true
  cp "$metro_log" "$report_dir/metro.log" 2>/dev/null || true
}
trap cleanup EXIT

adb install -r apps/mobile/android/app/build/outputs/apk/debug/app-debug.apk
adb reverse tcp:8081 tcp:8081
pnpm --filter @rakazo/mobile exec expo start --port 8081 > "$metro_log" 2>&1 &
metro_pid=$!

for attempt in {1..60}; do
  if curl --fail --silent http://127.0.0.1:8081/status | grep -q running; then
    break
  fi
  if [[ "$attempt" == 60 ]]; then
    echo "Metro did not become ready." >&2
    exit 1
  fi
  sleep 1
done

pnpm test:mobile-screenshots
