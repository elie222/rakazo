import { enableCompileCache, flushCompileCache } from "node:module";

// Keeps V8's compiled main bundle on disk, keyed by its contents and the runtime, so a
// launch after the first skips most of the compile. It only covers modules loaded after
// this call, so the bundle loads from here.
enableCompileCache();
await import("./main.js");
// Saved now rather than at exit, which a crash or forced quit never reaches.
flushCompileCache();
