import { existsSync } from "node:fs";
import { enableCompileCache, flushCompileCache } from "node:module";
import path from "node:path";

// Keeps V8's compiled main bundle on disk, keyed by its contents and the runtime, so a
// launch after the first skips most of the compile. It only covers modules loaded after
// this call, so the bundle loads from here.
enableCompileCache();
// A page installed as its own app is a copy of Rakazo carrying its page's config.
if (existsSync(path.join(process.resourcesPath, "page-app.json"))) await import("./page-app.js");
else await import("./main.js");
// Saved now rather than at exit, which a crash or forced quit never reaches.
flushCompileCache();
