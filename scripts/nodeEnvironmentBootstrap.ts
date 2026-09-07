// Must be the first import of the custom server entry.
//
// Next's `dist/server/app-render/async-local-storage.js` reads
// `globalThis.AsyncLocalStorage` exactly once, when the module is first
// evaluated. If the global isn't there yet it hands out a FakeAsyncLocalStorage
// whose `run`/`exit`/`enterWith` throw
// "Invariant: AsyncLocalStorage accessed in runtime where it is not available"
// — and it keeps doing so for the life of the process, because that lookup is
// never retried.
//
// Next normally sets the global from `dist/server/node-environment-baseline.js`
// ("This file should be imported before any others"), but a custom server never
// gets that ordering for free: `import next from "next"` doesn't pull
// node-environment in, so it first runs from start-server -> router-server
// inside `app.prepare()`. Every import of ours is evaluated before that, and
// anything that transitively reaches `next/server` (libs/validate.ts imports
// NextResponse, and libs/apps.ts reaches it via libs/apps/manifest.ts) loads the
// app-render store while the global is still missing. The crash then lands
// somewhere unrelated-looking: Next's console-exit extension calls
// `workAsyncStorage.exit()` on every console.*, so the next log line after
// prepare() takes the process down, with a stack pointing at the shared error
// object's construction site rather than at the caller.
//
// Doing what node-environment-baseline would have done, before any other import
// of the entry, closes that window. Covered by libs/__tests__/serverEntryNodeEnv.test.ts.
import { AsyncLocalStorage } from "node:async_hooks";

const g = globalThis as { AsyncLocalStorage?: unknown };
if (typeof g.AsyncLocalStorage !== "function") {
  g.AsyncLocalStorage = AsyncLocalStorage;
}
