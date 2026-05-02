// Package api hand-written handlers. The oapi-codegen output in
// openapi_gen.go provides shared types; concrete behavior lives here
// alongside it (one file per Next.js route subtree).
package api

import (
	"encoding/json"
	"net/http"
)

// ListTasksMeta is the Go side of GET /api/tasks/meta. The Next handler
// (app/api/tasks/meta/route.ts) returns `{[taskId]: Meta}` — an empty
// object when sessions/ has no task dirs. S04 ships this as a stub
// returning `{}` so the contract framework can prove byte-parity end
// to end. Real session walking + stale reaper port lands in S10/S11.
func ListTasksMeta(w http.ResponseWriter, _ *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]any{})
}

// WriteJSON marshals body and writes it without a trailing newline.
// The encoder/decoder pair `json.NewEncoder + Encode` appends `\n`,
// which would diverge from Next's `NextResponse.json` (uses
// JSON.stringify, no newline) and break bytewise contract checks.
// Centralized here so every handler in this package picks up the
// same framing.
func WriteJSON(w http.ResponseWriter, status int, body any) {
	buf, err := json.Marshal(body)
	if err != nil {
		http.Error(w, `{"error":"encode failed"}`, http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_, _ = w.Write(buf)
}
