# harness-lab

Mock websites for testing an AI agent that drives a real browser, the way a personal assistant would: log in, navigate, download PDFs, book a flight. They are driven by the `pnpm test:flows` benchmark (see Flows below); the grocery-store flow lives separately in `packages/testkit/src/flows/sites/freshcart`. Everything is fictional: invented brands, fake people, synthetic numbers, test-mode payments that never charge anything. The sites copy how real sites behave (OTP logins, iframes, SPAs, interstitials), not how they look.

One process serves every site, so one container image (`harness-lab/mocks`) is enough.

| Port | Site | Tests |
| --- | --- | --- |
| 7000 | Lab inbox, event log, control API | where SMS/email codes appear; reset; assertions |
| 7001 | Kedem Pensions (pension and insurance portal) | SMS login inside a cross-origin iframe, PDF-only data, session timeout |
| 7011 | Kedem login frame (the iframe's origin) | |
| 7002 | Tavor Investment House (investment dashboard) | password + SMS/email second factor, SPA, shadow DOM, slow tables, PDF and CSV |
| 7003 | Skybird Flights | autocomplete, date picker, filters, seats, price-changed interstitial, test payment |

## Run

```sh
pnpm --filter @rakazo/harness-lab dev          # plain Node, binds 127.0.0.1
docker build -f harness-lab/Dockerfile -t harness-lab/mocks .
docker run --rm --network harness-lab-net \
  -p 127.0.0.1:7000-7003:7000-7003 -p 127.0.0.1:7011:7011 harness-lab/mocks
```

The container binds 0.0.0.0 inside its network; publish ports on 127.0.0.1 only. The sites are not hardened. Other containers on the same docker network reach them as `http://<container-name>:<port>`; the login iframe URL is built from the host the browser used, so this works under any hostname.

Settings (environment, all optional): `HARNESS_LAB_BIND`, `HARNESS_LAB_DELAY_SCALE` (1 = 2-4 s spinners, 0 = none), `HARNESS_LAB_SESSION_TTL_MS`, `HARNESS_LAB_OTP_TTL_MS`, `HARNESS_LAB_RESEND_COOLDOWN_MS`, `HARNESS_LAB_MAX_OTP_ATTEMPTS`, `HARNESS_LAB_LOCKOUT_MS`, `HARNESS_LAB_TOKEN` (when set, `POST /api/*` on the control API needs an `x-lab-token` header), `HARNESS_LAB_FONT` (a TTF with Hebrew for the PDFs).

## HTTPS

Real portals are HTTPS, and the product's saved-login path (`request_secret`, `fill_secret`) works only on HTTPS origins, so the lab can serve its sites over TLS. Without certificates it serves plain HTTP, which keeps `pnpm start` usable anywhere.

```sh
harness-lab/scripts/lab-ca.sh [dir]        # a lab-only root CA plus a server certificate (default harness-lab/.certs, git-ignored)
HARNESS_LAB_TLS_DIR=/path/to/lab-ca/server pnpm start   # lab.crt and lab.key; the sites and the login frame become https
```

The control port stays plain HTTP (token-gated, for the runner). The bot's computer must trust `ca.crt` (system store and the browser's); flows probe the site from inside the computer first and say so if it does not. `HARNESS_LAB_BOT_SCHEME=http` makes the flows use plain HTTP against a lab without TLS.

## Control API (port 7000)

| Endpoint | Purpose |
| --- | --- |
| `GET /` | human view of the inbox (`?to=0555000101`) |
| `GET /api/latest-code?to=<phone or email>&site=` | newest one-time code sent to that recipient |
| `GET /api/messages?to=&site=&channel=` | every SMS/email sent |
| `GET /api/events?site=&type=&since=<seq>` | event log: every request plus semantic events (`login.attempt`, `otp.sent`, `otp.verify` with `ok`, `login.success`, `report.download`, `statement.download`, `search`, `offer.selected`, `payment.submitted`, `booking.confirmed`, `order.confirmed`) |
| `POST /api/reset` | wipe all state: sessions, codes, carts, events, clock |
| `POST /api/clock/advance` `{"ms": 300000}` | move the lab clock to test OTP expiry and session timeouts without waiting |
| `GET /api/fixtures` | the contents of `fixtures/*.json` |
| `GET/POST /api/config` | A/B variants (below); reset restores the defaults |

Sites keep state in memory only. Tokens, codes and references are deterministic after a reset: the same actions give the same values.

## Variants (A/B diagnosis)

`POST /api/config {"pension": {...}}` removes one obstacle at a time, so a failing run can be blamed on the iframe, the code or the PDF:

| Setting | Default | Variant |
| --- | --- | --- |
| `login` | `"iframe"`: form served from another origin | `"inline"`: same form on the top page |
| `otp` | `true`: SMS code after ID and phone | `false`: no second factor |
| `html` | `false`: yearly returns only in the PDFs | `true`: also in an HTML table on the reports page |

## Flows

The flows live in `packages/testkit/src/flows` and plug into `pnpm test:flows` (ids in `--list`): `pension-returns`, `pension-returns:inline`, `pension-returns:no-otp`, `pension-returns:html`, `invest-quarterly`, `book-cheapest-flight`. Each resets the lab, sets its variant, checks the bot's computer can reach the lab, gives the simulated person the code as a live fact (so the bot can ask for it in chat), and grades from the lab's event log. Results carry wall-clock `startedAt`/`endedAt` and `metrics`: seconds from flow start to login page, code requested, code submitted, login ok, first and last download and the final answer, plus whether the code came through chat or a screen takeover.

```sh
# the bot's computer must reach the lab by this host (container name on harness-lab-net, or host.docker.internal)
pnpm test:flows --flow pension-returns:inline --lab-host harness-lab-mocks --sandbox docker
# lab control API as seen from the machine running the benchmark (default http://127.0.0.1:7000)
pnpm test:flows --flow pension-returns --lab-url http://127.0.0.1:7000 --lab-host host.docker.internal
```

`HARNESS_LAB_URL` and `HARNESS_LAB_BOT_HOST` set the same two values. A scripted run (no model) is `pnpm vitest run packages/testkit/src/flows/lab-flows.test.ts`: an HTTP script plays the bot against the real servers and checks setup, grading and metrics.

## Fixtures

`fixtures/{pension,invest,flights}.json` list every fake user (ID, phone, email, password) and the correct answers, for example the yearly returns that exist only in the pension PDFs. They are generated from `src/data.ts` (`pnpm fixtures`); a unit test fails if they drift.

## Tests

```sh
pnpm --filter @rakazo/harness-lab test    # unit tests: login flows, OTP expiry and lockout, PDF text extraction
pnpm --filter @rakazo/harness-lab check   # types
pnpm --filter @rakazo/harness-lab smoke   # real-browser walk-through against a running lab (needs Playwright's Chromium)
```

## What each site tests

**Kedem Pensions.** ID number with a valid Israeli check digit plus mobile number, terms checkbox, then a 6-digit SMS code (5 minutes, 30-second resend cooldown, lockout after 3 wrong tries for 15 minutes). The form is in an iframe on another origin and hands a one-time ticket to the page with `postMessage`. A cookie banner and a promo modal block the first view. Yearly returns, fees and closing balances exist only in the annual-report PDFs for 2023-2025 (one per product and year, 2024 and 2023 sit in collapsed sections; Hebrew text in the PDFs is stored in visual order, so extraction reverses it while numbers and English labels extract cleanly). The session ends after 10 minutes of inactivity and bounces to login.

**Tavor.** Username and password, then a choice of SMS or email for the second factor. After login everything is a single-page app with client-side routing. Tables load after a 2-4 second spinner; the account summary is an open shadow-DOM component; statements come as PDF and CSV; the quarterly report sits two menu levels deep (Reports, Periodic reports, Quarterly). Five wrong passwords lock the user. The session ends after 10 minutes of inactivity (`HARNESS_LAB_SESSION_TTL_MS`).

**Skybird.** Airport autocomplete that fetches as you type, a custom calendar widget (no native date input), sort and filters on results, about a quarter of fares re-price at selection and show a "price changed" interstitial, seat map with taken seats and paid legroom rows, English-only passenger names with validation, and a payment page that records the submission but never charges: it ends on a test-mode confirmation with a booking reference.

**Inbox.** Not a site under test: the lab runner reads codes from it, asserts on the event log, and resets state between runs.
