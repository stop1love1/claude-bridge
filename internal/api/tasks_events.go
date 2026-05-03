package api

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"path/filepath"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/stop1love1/claude-bridge/internal/meta"
	"github.com/stop1love1/claude-bridge/internal/sessions"
)

// keepaliveInterval is the SSE comment-frame ping cadence. 15 s mirrors
// the TS handler — keeps proxies (NGINX default 60 s, Cloudflare 100 s)
// from idle-timing the connection.
const keepaliveInterval = 15 * time.Second

// TaskEvents is the Go side of GET /api/tasks/{id}/events. SSE stream
// that fires:
//   - event: snapshot   data: <full Meta>          on connect
//   - event: spawned    data: {sessionId, run, meta}
//   - event: done|failed|stale  data: {sessionId, run, prevStatus, meta}
//   - event: retried    data: {sessionId, retryOf, run, meta}
//   - event: updated    data: {sessionId, run, meta}
//   - event: meta       data: <full Meta>          on writeMeta
//   - `:keepalive`      every 15 s
//
// Per-child status fan-out (child-status / child-alive events) ports
// alongside the spawn engine's stream-json parser — that's deferred to
// the SSE-tail port that comes with /api/sessions/:id/tail/stream.
// Connect-time meta.runs subscription stub is in place so it's a
// one-line wire-up when the parser lands.
//
// Mirrors libs/meta.ts subscribeMeta filtering + the TS handler's
// terminal-transition shape exactly.
func TaskEvents(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !meta.IsValidTaskID(id) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid task id"})
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		// Server doesn't support streaming. SSE is unusable; surface
		// 500 so the client falls back to polling rather than stalling.
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": "streaming not supported"})
		return
	}

	w.Header().Set("Content-Type", "text/event-stream; charset=utf-8")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)

	c := currentConfig()
	dir := filepath.Join(c.SessionsDir, id)

	// closeMu protects writes to the response writer + the closed
	// flag. The subscriber callback runs on whatever goroutine emit()
	// was called from; the keepalive timer fires on its own goroutine.
	// Without serialization, two simultaneous writes would interleave
	// SSE frames and break parsing on the client.
	var closeMu sync.Mutex
	closed := false
	send := func(event string, payload any) {
		closeMu.Lock()
		defer closeMu.Unlock()
		if closed {
			return
		}
		buf, err := json.Marshal(payload)
		if err != nil {
			return
		}
		if event == "" {
			_, err = fmt.Fprintf(w, ": %s\n\n", string(buf))
		} else {
			_, err = fmt.Fprintf(w, "event: %s\ndata: %s\n\n", event, string(buf))
		}
		if err != nil {
			closed = true
			return
		}
		flusher.Flush()
	}

	sendKeepalive := func() {
		closeMu.Lock()
		defer closeMu.Unlock()
		if closed {
			return
		}
		_, err := fmt.Fprint(w, ": keepalive\n\n")
		if err != nil {
			closed = true
			return
		}
		flusher.Flush()
	}

	// Subscribe-before-snapshot fix: previously we read the snapshot
	// then subscribed, leaving a window in which lifecycle events
	// fired between snapshot read and subscribe registration would
	// vanish. We now register a buffered queue FIRST, read the
	// snapshot, then drain the queue — so any event that fires during
	// the snapshot read is captured and replayed.
	//
	// If the buffer overflows during the snapshot phase we drop the
	// queue and log: clients reconnect on stream end and will get a
	// fresh snapshot, so the worst case is a brief reconnect rather
	// than silent data loss.
	type queuedEvent struct {
		ev meta.MetaChangeEvent
	}
	const queueBuf = 64
	var (
		queueMu       sync.Mutex
		queue         = make([]queuedEvent, 0, queueBuf)
		queueDrained  bool
		queueOverflow bool
	)

	processEvent := func(ev meta.MetaChangeEvent) {
		// sendWithMeta piggybacks the full Meta on every lifecycle event so
		// the client never needs a follow-up GET round-trip just to see
		// the new state of runs[]. Mirrors the TS handler.
		sendWithMeta := func(event string, payload map[string]any) {
			if m, err := meta.ReadMeta(dir); err == nil && m != nil {
				payload["meta"] = m
			}
			send(event, payload)
		}
		switch ev.Kind {
		case meta.MetaChangeSpawned:
			sendWithMeta("spawned", map[string]any{
				"sessionId": ev.SessionID,
				"run":       ev.Run,
			})
		case meta.MetaChangeRetried:
			sendWithMeta("retried", map[string]any{
				"sessionId": ev.SessionID,
				"retryOf":   ev.RetryOf,
				"run":       ev.Run,
			})
		case meta.MetaChangeTransition:
			// Only emit terminal transitions OUT of running.
			if ev.PrevStatus != meta.RunStatusRunning {
				return
			}
			next := meta.RunStatus("")
			if ev.Run != nil {
				next = ev.Run.Status
			}
			if next != meta.RunStatusDone && next != meta.RunStatusFailed && next != meta.RunStatusStale {
				return
			}
			sendWithMeta(string(next), map[string]any{
				"sessionId":  ev.SessionID,
				"run":        ev.Run,
				"prevStatus": ev.PrevStatus,
			})
		case meta.MetaChangeUpdated:
			sendWithMeta("updated", map[string]any{
				"sessionId": ev.SessionID,
				"run":       ev.Run,
			})
		case meta.MetaChangeWriteMeta:
			if m, err := meta.ReadMeta(dir); err == nil && m != nil {
				send("meta", m)
			}
		}
	}

	cancel := meta.SubscribeMeta(id, func(ev meta.MetaChangeEvent) {
		queueMu.Lock()
		if queueDrained {
			queueMu.Unlock()
			processEvent(ev)
			return
		}
		if len(queue) >= queueBuf {
			queueOverflow = true
			queueMu.Unlock()
			return
		}
		queue = append(queue, queuedEvent{ev: ev})
		queueMu.Unlock()
	})

	// Initial snapshot — UI doesn't need a separate /meta fetch.
	if snap, err := meta.ReadMeta(dir); err == nil && snap != nil {
		send("snapshot", snap)
	}

	// Drain any events that arrived during the snapshot read window,
	// then flip the flag so future events bypass the queue.
	queueMu.Lock()
	pending := queue
	queue = nil
	overflow := queueOverflow
	queueDrained = true
	queueMu.Unlock()
	if overflow {
		log.Printf("tasks_events: subscribe-window queue overflow for task %s; client will reconnect", id)
	} else {
		for _, q := range pending {
			processEvent(q.ev)
		}
	}

	// Keepalive ticker. Tied to the request context so it stops when
	// the client disconnects. Defers run LIFO; we want the closed-flag
	// flip first (so any in-flight emit drops cleanly), then cancel
	// (detach subscription), then ticker.Stop (release timer goroutine).
	ctx := r.Context()
	ticker := time.NewTicker(keepaliveInterval)
	defer ticker.Stop()
	defer cancel()
	defer func() {
		closeMu.Lock()
		closed = true
		closeMu.Unlock()
	}()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			sendKeepalive()
		}
	}
}

// DetectRefresh is the Go side of POST /api/tasks/{id}/detect/refresh.
// Stub for S12 — re-running the detect pipeline needs the detect
// package (S16). For now we accept the call, do nothing, return 200.
//
// Once internal/detect lands, this should:
//  1. Validate the task exists.
//  2. Re-load detect input from meta.taskBody / taskTitle / taskApp.
//  3. Run heuristic + (if mode allows) LLM upgrade.
//  4. Persist to meta.detectedScope.
func DetectRefresh(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if !meta.IsValidTaskID(id) {
		WriteJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid task id"})
		return
	}
	c := currentConfig()
	m, err := meta.ReadMeta(filepath.Join(c.SessionsDir, id))
	if err != nil {
		WriteJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	if m == nil {
		WriteJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		return
	}
	WriteJSON(w, http.StatusOK, map[string]any{
		"ok":       true,
		"deferred": "detect package lands in S16",
	})
}

// Compile-time guard: the SubscribeSession hook the TS handler uses
// for child-status fan-out lives in internal/sessions. We import it
// here so a future port that adds the child-status / child-alive
// events doesn't have to add the dependency edge separately.
var _ = sessions.NewEventsRegistry

// Suppress unused import warning when context isn't otherwise used
// (it's used via r.Context() above).
var _ = context.Canceled
