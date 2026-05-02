package api

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/stop1love1/claude-bridge/internal/permission"
	"github.com/stop1love1/claude-bridge/internal/sessions"
)

// AnnouncePermissionBody is the payload from the permission hook script.
// SessionID + RequestID + Tool are required; Input may be any JSON
// shape (depends on the tool).
type AnnouncePermissionBody struct {
	SessionID string `json:"sessionId"`
	RequestID string `json:"requestId"`
	Tool      string `json:"tool"`
	Input     any    `json:"input"`
}

// AnnouncePermission — POST /api/permission. The hook script calls
// this when claude wants to invoke a tool gated by PreToolUse. The
// bridge announces the request to the operator and waits for a
// decision on the GET-poll endpoint or the SSE stream.
func AnnouncePermission(w http.ResponseWriter, r *http.Request) {
	defer func() { _ = r.Body.Close() }()
	var body AnnouncePermissionBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	if !sessions.IsValidSessionID(body.SessionID) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid sessionId"})
		return
	}
	if body.RequestID == "" || body.Tool == "" {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "requestId and tool required"})
		return
	}
	req := permission.Default.AnnouncePending(permission.Request{
		SessionID: body.SessionID,
		RequestID: body.RequestID,
		Tool:      body.Tool,
		Input:     body.Input,
		CreatedAt: time.Now().UTC().Format(time.RFC3339Nano),
	})
	WriteJSON(w, http.StatusOK, req)
}

// ListAllPermissions — GET /api/permission. Returns every still-
// pending request across every session for the page-wide dialog.
func ListAllPermissions(w http.ResponseWriter, _ *http.Request) {
	WriteJSON(w, http.StatusOK, map[string]any{
		"pending": permission.Default.ListAllPending(),
	})
}

// AnswerPermissionBody is the payload from the operator's
// allow/deny click.
type AnswerPermissionBody struct {
	Decision string `json:"decision"`
	Reason   string `json:"reason,omitempty"`
}

// AnswerPermission — POST /api/permission/{requestId}. The operator
// clicked allow or deny in the dialog; surface the decision so the
// hook poller picks it up on its next tick.
//
// The TS handler accepts the (sessionId, requestId) pair via path
// params; the chi route uses just requestId because the HTTP layer
// can't fan-out one decision across sessions (the requestId is unique
// per claude turn). The store still keys on (sessionId, requestId)
// for correctness.
func AnswerPermission(w http.ResponseWriter, r *http.Request) {
	requestID := chi.URLParam(r, "requestId")
	if requestID == "" {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "requestId required"})
		return
	}
	defer func() { _ = r.Body.Close() }()
	var body AnswerPermissionBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	decision := permission.Status(body.Decision)
	if decision != permission.StatusAllow && decision != permission.StatusDeny {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "decision must be allow|deny"})
		return
	}
	// Find the matching pending entry by requestId. listAllPending is
	// a small map walk; production deployments rarely have more than a
	// handful of in-flight requests at once.
	var match *permission.Request
	for _, p := range permission.Default.ListAllPending() {
		if p.RequestID == requestID {
			cp := p
			match = &cp
			break
		}
	}
	if match == nil {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "request not found"})
		return
	}
	updated, ok := permission.Default.Answer(match.SessionID, requestID, decision, body.Reason)
	if !ok {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "request not found"})
		return
	}
	WriteJSON(w, http.StatusOK, updated)
}

// PermissionStream — GET /api/permission/stream. SSE stream that fires
// `event: permission.request` for every newly-announced pending request
// across every session, plus `event: permission.answered` when one is
// resolved. Mirrors libs/permissionStore.ts subscribeAll exactly.
func PermissionStream(w http.ResponseWriter, r *http.Request) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming not supported"})
		return
	}
	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	var mu sync.Mutex
	closed := false
	send := func(event string, payload any) {
		mu.Lock()
		defer mu.Unlock()
		if closed {
			return
		}
		buf, _ := json.Marshal(payload)
		_, err := fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, string(buf))
		if err != nil {
			closed = true
			return
		}
		flusher.Flush()
	}

	cancel := permission.Default.SubscribeAll(
		func(req permission.Request) { send("permission.request", req) },
		func(req permission.Request) { send("permission.answered", req) },
	)
	defer cancel()

	// Replay the current pending set on connect so a reconnecting
	// client doesn't miss requests that landed before the stream was
	// re-attached.
	for _, p := range permission.Default.ListAllPending() {
		send("permission.request", p)
	}

	ctx := r.Context()
	ticker := time.NewTicker(15 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			mu.Lock()
			closed = true
			mu.Unlock()
			return
		case <-ticker.C:
			mu.Lock()
			if closed {
				mu.Unlock()
				return
			}
			_, err := fmt.Fprint(w, ": keepalive\n\n")
			if err != nil {
				closed = true
				mu.Unlock()
				return
			}
			flusher.Flush()
			mu.Unlock()
		}
	}
}

// SessionPermissions — GET /api/sessions/{sessionId}/permission.
// Lists pending requests scoped to one session.
func SessionPermissions(w http.ResponseWriter, r *http.Request) {
	sid := chi.URLParam(r, "sessionId")
	if !sessions.IsValidSessionID(sid) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid sessionId"})
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"pending": permission.Default.ListPending(sid),
	})
}

// GetSessionPermission — GET /api/sessions/{sessionId}/permission/{requestId}.
// Returns the named pending or answered request.
func GetSessionPermission(w http.ResponseWriter, r *http.Request) {
	sid := chi.URLParam(r, "sessionId")
	rid := chi.URLParam(r, "requestId")
	if !sessions.IsValidSessionID(sid) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid sessionId"})
		return
	}
	req, ok := permission.Default.Get(sid, rid)
	if !ok {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	WriteJSON(w, http.StatusOK, req)
}

// DecideSessionPermission — POST /api/sessions/{sessionId}/permission/{requestId}.
// The hook poller actually reads via GetSessionPermission; this is the
// operator's decision endpoint, scoped to one session.
func DecideSessionPermission(w http.ResponseWriter, r *http.Request) {
	sid := chi.URLParam(r, "sessionId")
	rid := chi.URLParam(r, "requestId")
	if !sessions.IsValidSessionID(sid) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid sessionId"})
		return
	}
	defer func() { _ = r.Body.Close() }()
	var body AnswerPermissionBody
	if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid JSON"})
		return
	}
	decision := permission.Status(body.Decision)
	updated, ok := permission.Default.Answer(sid, rid, decision, body.Reason)
	if !ok {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "request not found"})
		return
	}
	WriteJSON(w, http.StatusOK, updated)
}
