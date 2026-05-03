// Package permission is the in-memory store for PreToolUse permission
// requests surfaced from the claude permission hook script. Survives
// across HTTP requests via a process-global singleton; NOT persisted
// to disk — these are ephemeral by design (a server restart drops
// every pending request, which times out the hook, which fails open
// and lets claude proceed).
//
// Ported from libs/permissionStore.ts in S28.
package permission

import (
	"sync"
)

// Status discriminates the lifecycle state of a request.
type Status string

const (
	StatusPending Status = "pending"
	StatusAllow   Status = "allow"
	StatusDeny    Status = "deny"
)

// Request is one PreToolUse hook invocation. The model wants to call
// Tool with Input; the bridge surfaces it to the operator (via the
// global PermissionDialog), captures the decision, and posts back so
// the hook can return allow/deny to claude.
type Request struct {
	SessionID string `json:"sessionId"`
	RequestID string `json:"requestId"`
	Tool      string `json:"tool"`
	Input     any    `json:"input,omitempty"`
	Status    Status `json:"status"`
	Reason    string `json:"reason,omitempty"`
	CreatedAt string `json:"createdAt"`
}

// pendingHandler / answeredHandler are the per-channel callback types
// passed into Subscribe / SubscribeAll.
type pendingHandler func(Request)
type answeredHandler func(Request)

type sessionSubs struct {
	mu       sync.Mutex
	pending  []pendingHandler
	answered []answeredHandler
}

// Store holds every in-flight permission request keyed by
// (sessionID, requestID). Per-session emitters fan out to subscribers
// watching one session; the global emitter fans out to subscribers
// watching every session (PermissionDialog mounted page-wide,
// Telegram notifier, …).
type Store struct {
	mu       sync.Mutex
	pending  map[string]*Request
	sessions map[string]*sessionSubs
	global   *sessionSubs
}

// NewStore returns an empty store. Production uses Default; tests
// construct their own for isolation.
func NewStore() *Store {
	return &Store{
		pending:  make(map[string]*Request),
		sessions: make(map[string]*sessionSubs),
		global:   &sessionSubs{},
	}
}

// Default is the package-global store. Mirrors the TS module's
// globalThis stash.
var Default = NewStore()

func key(sessionID, requestID string) string {
	return sessionID + ":" + requestID
}

// AnnouncePending records a fresh request in the store and notifies
// every subscriber. Returns the canonicalized record (status set to
// pending).
func (s *Store) AnnouncePending(req Request) Request {
	req.Status = StatusPending
	s.mu.Lock()
	s.pending[key(req.SessionID, req.RequestID)] = &req
	subs := s.sessionSubsLocked(req.SessionID)
	global := s.global
	s.mu.Unlock()
	dispatchPending(subs, req)
	dispatchPending(global, req)
	return req
}

func (s *Store) sessionSubsLocked(sid string) *sessionSubs {
	subs, ok := s.sessions[sid]
	if !ok {
		subs = &sessionSubs{}
		s.sessions[sid] = subs
	}
	return subs
}

// Get returns the request by (sessionID, requestID) or nil + false.
// Returned pointer is a copy — callers can read freely without
// holding the store lock.
func (s *Store) Get(sessionID, requestID string) (*Request, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	r, ok := s.pending[key(sessionID, requestID)]
	if !ok {
		return nil, false
	}
	cp := *r
	return &cp, true
}

// ListPending returns every pending request for sessionID.
func (s *Store) ListPending(sessionID string) []Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Request
	for _, r := range s.pending {
		if r.SessionID == sessionID && r.Status == StatusPending {
			out = append(out, *r)
		}
	}
	return out
}

// ListAllPending returns every pending request across every session.
// Used by the page-wide PermissionDialog.
func (s *Store) ListAllPending() []Request {
	s.mu.Lock()
	defer s.mu.Unlock()
	var out []Request
	for _, r := range s.pending {
		if r.Status == StatusPending {
			out = append(out, *r)
		}
	}
	return out
}

// Answer marks a request answered. Returns the updated record + true,
// or zero + false if the (sessionID, requestID) wasn't pending.
func (s *Store) Answer(sessionID, requestID string, decision Status, reason string) (Request, bool) {
	if decision != StatusAllow && decision != StatusDeny {
		return Request{}, false
	}
	s.mu.Lock()
	r, ok := s.pending[key(sessionID, requestID)]
	if !ok {
		s.mu.Unlock()
		return Request{}, false
	}
	r.Status = decision
	r.Reason = reason
	answered := *r
	subs := s.sessions[sessionID]
	global := s.global
	s.mu.Unlock()
	dispatchAnswered(subs, answered)
	dispatchAnswered(global, answered)
	return answered, true
}

// Consume drops the request from the store. Called by the hook's poll
// handler after it reads the final answer — keeps the map from leaking.
//
// Also evicts the per-session subscribers struct when the session has
// no remaining pending entries AND no active subscribers — without
// this, the sessions map grows monotonically across the bridge's
// lifetime.
func (s *Store) Consume(sessionID, requestID string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.pending, key(sessionID, requestID))
	subs, ok := s.sessions[sessionID]
	if !ok {
		return
	}
	subs.mu.Lock()
	hasSubs := len(subs.pending)+len(subs.answered) > 0
	subs.mu.Unlock()
	if hasSubs {
		return
	}
	for _, r := range s.pending {
		if r.SessionID == sessionID {
			return
		}
	}
	delete(s.sessions, sessionID)
}

// Subscribe attaches per-session callbacks. Returns an unsubscribe
// closer.
func (s *Store) Subscribe(sessionID string, onPending pendingHandler, onAnswered answeredHandler) func() {
	s.mu.Lock()
	subs := s.sessionSubsLocked(sessionID)
	s.mu.Unlock()
	return attach(subs, onPending, onAnswered)
}

// SubscribeAll attaches global callbacks — fires for every session's
// pending / answered events. Used by the page-wide PermissionDialog
// + the Telegram notifier (S22+).
func (s *Store) SubscribeAll(onPending pendingHandler, onAnswered answeredHandler) func() {
	return attach(s.global, onPending, onAnswered)
}

func attach(subs *sessionSubs, onPending pendingHandler, onAnswered answeredHandler) func() {
	subs.mu.Lock()
	if onPending != nil {
		subs.pending = append(subs.pending, onPending)
	}
	if onAnswered != nil {
		subs.answered = append(subs.answered, onAnswered)
	}
	subs.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			subs.mu.Lock()
			defer subs.mu.Unlock()
			subs.pending = removePending(subs.pending, onPending)
			subs.answered = removeAnswered(subs.answered, onAnswered)
		})
	}
}

func dispatchPending(subs *sessionSubs, r Request) {
	if subs == nil {
		return
	}
	subs.mu.Lock()
	hs := append([]pendingHandler(nil), subs.pending...)
	subs.mu.Unlock()
	for _, h := range hs {
		safePending(h, r)
	}
}

func dispatchAnswered(subs *sessionSubs, r Request) {
	if subs == nil {
		return
	}
	subs.mu.Lock()
	hs := append([]answeredHandler(nil), subs.answered...)
	subs.mu.Unlock()
	for _, h := range hs {
		safeAnswered(h, r)
	}
}

func safePending(h pendingHandler, r Request)   { defer func() { _ = recover() }(); h(r) }
func safeAnswered(h answeredHandler, r Request) { defer func() { _ = recover() }(); h(r) }

func removePending(hs []pendingHandler, target pendingHandler) []pendingHandler {
	if target == nil {
		return hs
	}
	for i := range hs {
		if reflectFuncEq(hs[i], target) {
			return append(hs[:i], hs[i+1:]...)
		}
	}
	return hs
}

func removeAnswered(hs []answeredHandler, target answeredHandler) []answeredHandler {
	if target == nil {
		return hs
	}
	for i := range hs {
		if reflectFuncEq(hs[i], target) {
			return append(hs[:i], hs[i+1:]...)
		}
	}
	return hs
}
