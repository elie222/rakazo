/**
 * Waits for a screen's browser, which `launch_browser`, `browser_running` and `browser_matches`
 * in the calling script start and find, and restarts one that is open but has stopped answering.
 */
export function browserReadyCommand(
  debugPort: number | string,
  pidFile: string,
  browserLog: string,
  screenNotReadyExit: number,
) {
  return [
    // An open port is not enough: a browser whose main thread is stuck keeps its port but stops
    // answering DevTools, so the screen shows a frozen page and every page tool times out. Its
    // backlog also fills, so even connecting can hang: every check here has a time limit.
    "port_open() {",
    `  timeout 2 bash -c 'exec 7<>/dev/tcp/127.0.0.1/$1' desktop ${debugPort} 2>/dev/null`,
    "}",
    "browser_answers() {",
    `  timeout 2 bash -c 'exec 7<>/dev/tcp/127.0.0.1/$1 && printf "GET /json/version HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nConnection: close\\r\\n\\r\\n" >&7 && IFS= read -r line <&7 && case "$line" in "HTTP/1."*" 200"*) exit 0 ;; esac; exit 1' desktop ${debugPort} 2>/dev/null`,
    "}",
    // A browser this call started is ready once its port opens; one already open must answer.
    "browser_ready() {",
    '  if [ "$found_open" -eq 1 ]; then browser_answers; else port_open; fi',
    "}",
    `restarted_file=${pidFile}-restarted`,
    // At most one forced restart per screen in ten minutes, so a page that hangs the browser
    // again as it loads fails the screen instead of restarting it on every call.
    "restarted_recently() {",
    '  last=$(cat "$restarted_file" 2>/dev/null || echo 0)',
    "  case \"$last\" in ''|*[!0-9]*) last=0 ;; esac",
    "  [ $(( $(date +%s) - last )) -lt 600 ]",
    "}",
    "launched=",
    "relaunched=0",
    "found_open=0",
    "unanswered=0",
    "ready=0",
    "if browser_running; then found_open=1; else launch_browser; fi",
    "deadline=$((SECONDS + 20))",
    'while [ "$SECONDS" -lt "$deadline" ]; do',
    "  if browser_running; then",
    "    answer=0",
    "    browser_ready || answer=$?",
    '    if [ "$answer" -eq 0 ]; then ready=1; break; fi',
    // 124: connected, or still connecting, with no answer in time. A refused port is still starting.
    '    if [ "$found_open" -eq 1 ] && [ "$answer" -eq 124 ]; then',
    "      unanswered=$((unanswered + 1))",
    '      if [ "$unanswered" -ge 3 ]; then',
    '        if [ "$relaunched" -eq 1 ] || restarted_recently; then break; fi',
    "        relaunched=1",
    "        found_open=0",
    `        hung=$(cat ${pidFile} 2>/dev/null || true)`,
    '        browser_matches "$hung" && kill -KILL "$hung" 2>/dev/null || true',
    '        for i in $(seq 1 40); do browser_matches "$hung" || break; sleep 0.25; done',
    // A browser that outlives SIGKILL still holds the profile: a second one must not open it.
    '        browser_matches "$hung" && break',
    '        date +%s >"$restarted_file"',
    "        echo RAKAZO_BROWSER_RESTARTED=unresponsive",
    "        launch_browser",
    "        deadline=$((SECONDS + 20))",
    "      fi",
    "    else",
    "      unanswered=0",
    "    fi",
    // The browser found running can be closed, by its window or a home save, before its port
    // answers. Start it again once rather than wait out a browser that is gone.
    '  elif [ "$relaunched" -eq 0 ] && ! { [ -n "$launched" ] && kill -0 "$launched" 2>/dev/null; }; then',
    "    relaunched=1",
    "    found_open=0",
    "    launch_browser",
    "    deadline=$((SECONDS + 20))",
    "  fi",
    "  sleep 0.25",
    "done",
    // Asking again after an answer could fail on one dropped probe and fail a ready screen.
    'if [ "$ready" -eq 0 ] && { ! browser_running || ! browser_ready; }; then',
    `  echo "computer browser CDP not ready on ${debugPort} (running=$(browser_running && echo yes || echo no))" >&2`,
    `  tail -c 4000 ${browserLog} >&2 || true`,
    `  exit ${screenNotReadyExit}`,
    "fi",
  ];
}
