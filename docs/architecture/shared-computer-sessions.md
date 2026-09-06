# One workspace computer, independent agent screens

The hosted Team Computer allocates one Modal sandbox per workspace home. Agent
screens are X displays on that computer, not additional sandboxes. Each screen
has its own window manager, browser tabs, pointer, keyboard focus, and control
lease. The primary screen plus eight agent screens can coexist; idle agent
screens can be reclaimed while their durable browser profiles remain.

Files, installed tools, and command-line credentials are shared inside this
computer. Screens are work surfaces, not security boundaries. Separate workspace
computers remain separate authorization and storage boundaries. This change
does not widen access to another workspace or change the private-computer mode.

## Browser sign-ins

Each screen still uses a separate Chromium profile. Chromium does not support
concurrent processes sharing a live profile directory, or a single process
opening windows on several X displays:
https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md

The hosted image runs a browser session worker as the unprivileged desktop user.
It connects only to randomized loopback DevTools endpoints on that computer.
These endpoints are not tunneled, exposed through the viewer, or reachable from
the application API. The screen proxy continues to expose only its authenticated
viewer and control capabilities.

The worker synchronizes cookies (including HttpOnly cookies and transferable
partition keys) and local storage for open first-party pages. Storage keys keep
origins and browser storage partitions distinct. A three-way comparison avoids
unchanged screens overwriting another screen's update. Durable deletion markers
prevent a returning stale profile from restoring a signed-out session. Updates
are eventually consistent; an already open application may need a reload before
its interface reflects a changed session. Concurrent updates to the same key
are resolved in observation order.

Tabs, browsing history, sessionStorage, and desktop input stay screen-specific.
IndexedDB credentials, passkeys, device-bound sessions, and opaque cookie
partitions are not replicated by this worker. Some sites require verification
again; this is not a guarantee that every web authentication system transfers.
Connected service credentials remain managed by the existing integration system.

## Persistence and recovery

The shared cookie and local-storage state lives in the computer home with mode
0600 and atomic replacement. It is included in the same private durable backup
as the browser profiles. Cookie values, storage values, and visited origins are
never printed in the worker's logs. Before portable restoration, the controller
stops the session worker and browsers. After restoring the home, a new worker
loads restored state before the browsers reconnect. Native filesystem snapshots
use the same durable state; live browser connections and input grants do not
survive a restart.

The implementation uses the published DevTools Storage and DOMStorage APIs:
https://chromedevtools.github.io/devtools-protocol/tot/Storage/
https://chromedevtools.github.io/devtools-protocol/tot/DOMStorage/

Grok documents the same product distinction between one computer and separate
bot screens, but does not publish its underlying session-sharing implementation:
https://docs.x.ai/grok-bot/computer-and-apps
