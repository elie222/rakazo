# Dependency patches

`pnpm patch` overrides wired through `patches:` in `pnpm-workspace.yaml`. Each
one exists because the locked release ships a bug this repository hits; each
entry says when the patch can go. The updater and sandbox-supervisor Dockerfiles
copy this folder next to the lockfile, so a patch applies in production images
too — removing one means editing `pnpm-workspace.yaml` and the lockfile
(`pnpm patch-remove <pkg>`).

## `dockerode@5.0.1.patch`

Docker builds: a BuildKit session was closed only when a build ended cleanly, so
every rejected or aborted build leaked a socket connection, and the session
request ignored the caller's abort signal, so an unanswered session held the
build forever. The patch closes the session when the build stream closes or the
build fails immediately, and passes the abort signal through. Drop once an
upgrade fixes the same leak upstream — check a failing build actually releases
its connection.

Introduced in #2703.

## `expo-speech@58.0.4.patch`

Mobile speech: `Speech.speak` started the native call and dropped its promise,
so a voice iOS could not load (or text over the length limit) rejected with
nothing listening. The app saw an unhandled rejection, and read-aloud waiting
for `onDone` or `onError` never finished. The patch passes that rejection to the
utterance's `onError` and clears its callbacks. Drop once expo-speech reports a
rejected `speak` through `onError` itself — check a speak with an unknown voice
identifier calls `onError`.

## `fflate@0.8.3.patch`

Streaming `Deflate` (which `ZipDeflate` uses for account exports): on the first
push the match finder could reach into the empty, zero-filled part of its
window and emit distances pointing before the start of the data, producing
archives that unzip as "invalid distance". Applies upstream 101arrowz/fflate#261
(issues #260/#282), unreleased at 0.8.3; only the compressor's state changes,
decompression is untouched. Drop once fflate ships the fix — re-verify an
export containing a file that starts with zero bytes.

Introduced in #3694, which also carries the regression test.

## `@react-native-ai__apple@0.12.0.patch`

iOS on-device dictation (SpeechAnalyzer): `transcribe` resolved before the task
collecting final segments finished, so the last words of a dictation could be
lost, and it built its transcriber from the raw language tag rather than the
locale `prepare` installed. The patch awaits the collector, returns the
supported locale from `prepare`, and cleans up the temporary audio file on every
path. Ported from T3 Code's patch for the same release.

It also teaches dictation the person's own names: `transcribe` takes an optional
word list, and when the short-form dictation model is installed, one pass runs it
alongside the long-form transcriber with the words as contextual strings.
`TaughtWords.swift` swaps each taught word it heard into the long-form text, and
a failed pass retries without words. `prepare` fetches that model in the
background. Drop only once an upgrade awaits the results collector, returns the
supported locale from `prepare`, and gives the long-form transcript a word list
of its own.

## `react-native-enriched-markdown@1.2.0.patch`

On Android, wide code blocks and tables reserve the first motion events to
distinguish sideways drags from vertical chat scrolling. Their viewports
start at the physical left, and table layout preserves the user's scroll
position where it still fits. Drop when an upstream release handles both
behaviors in a vertical chat list (#6368, #6369).
