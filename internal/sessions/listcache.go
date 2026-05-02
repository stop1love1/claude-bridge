package sessions

import "sync/atomic"

// Tiny shared cache-bust hook for /api/sessions/all.
//
// The list endpoint caches its full response for ~2 s and invalidates
// automatically on every meta change event. That covers spawn / link /
// task-section moves, but NOT orphan-session changes (free chats that
// never write meta) — deleting an orphan removes the .jsonl from disk
// but the next poll still serves the stale cached row, so the UI looks
// like delete had no effect. Routes that mutate raw session files call
// BustSessionsListCache after success.
//
// In the TS module this lived on globalThis so it survived Next.js dev-
// server module reloads. Go has no HMR analogue, so a package-level
// atomic.Pointer is sufficient — and concurrent-safe by construction.

var sessionsListBuster atomic.Pointer[func()]

// SetSessionsListBuster registers the cache-bust callback. Called once
// at startup by the /api/sessions/all handler — subsequent calls
// overwrite the previous registration (matches TS semantics where
// setSessionsListBuster mutates the global slot).
func SetSessionsListBuster(fn func()) {
	if fn == nil {
		sessionsListBuster.Store(nil)
		return
	}
	sessionsListBuster.Store(&fn)
}

// BustSessionsListCache invokes the registered callback if any. Safe
// to call before SetSessionsListBuster — does nothing in that case.
func BustSessionsListCache() {
	if fn := sessionsListBuster.Load(); fn != nil {
		(*fn)()
	}
}
