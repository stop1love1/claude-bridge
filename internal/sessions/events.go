package sessions

import (
	"sync"
	"time"
)

// PartialEvent is one streamed assistant-text delta from
// `claude --output-format stream-json --include-partial-messages`.
// Forwarded so the SSE client can render Claude's reply token-by-token
// instead of waiting for the canonical .jsonl line that only lands
// when the turn is complete.
type PartialEvent struct {
	// MessageID is the assistant message id from the API (msg_…), so
	// the client can group deltas across content blocks within the
	// same turn.
	MessageID string `json:"messageId"`
	// Index is the content-block index. Claude can stream multiple
	// blocks (text + tool_use) within one message; we currently only
	// forward text.
	Index int `json:"index"`
	// Text is the delta fragment as emitted by
	// stream_event/content_block_delta.
	Text string `json:"text"`
}

// StatusEvent is the activity indicator the UI shows above the
// composer — mirrors what the claude CLI puts at the bottom of its
// terminal screen ("Thinking…", "Running: <bash>", etc.). Sourced
// from claude's system/status, system/task_started, and
// system/task_notification stream-json events.
//
//	thinking → API call is in flight; no tool running yet
//	running  → a tool / Bash / sub-task is executing; Label is the
//	           human-readable description claude attached to the task
//	idle     → message_stop fired or the child exited
type StatusEvent struct {
	Kind  string `json:"kind"`
	Label string `json:"label,omitempty"`
}

// PartialHandler / AliveHandler / StatusHandler are the per-channel
// callback types passed into SubscribeSession. Nil entries are skipped.
type (
	PartialHandler func(PartialEvent)
	AliveHandler   func(bool)
	StatusHandler  func(StatusEvent)
)

// SubscriptionHandlers bundles the optional callbacks SubscribeSession
// accepts. Mirrors the SessionSubscriptionHandlers shape from the TS
// module so callers can ignore channels they don't care about.
type SubscriptionHandlers struct {
	OnPartial PartialHandler
	OnAlive   AliveHandler
	OnStatus  StatusHandler
}

// emitter is the per-session pub/sub. Distinct slices per channel
// (rather than a single slice of an interface) avoid type assertions
// in the hot path. A sync.RWMutex protects mutation: subscribe/
// unsubscribe are rare relative to emit, and concurrent emits to
// disjoint sessions don't contend.
type emitter struct {
	mu       sync.RWMutex
	partials []PartialHandler
	alives   []AliveHandler
	statuses []StatusHandler
}

func (e *emitter) emitPartial(p PartialEvent) {
	e.mu.RLock()
	hs := append([]PartialHandler(nil), e.partials...)
	e.mu.RUnlock()
	for _, h := range hs {
		h(p)
	}
}

func (e *emitter) emitAlive(a bool) {
	e.mu.RLock()
	hs := append([]AliveHandler(nil), e.alives...)
	e.mu.RUnlock()
	for _, h := range hs {
		h(a)
	}
}

func (e *emitter) emitStatus(s StatusEvent) {
	e.mu.RLock()
	hs := append([]StatusHandler(nil), e.statuses...)
	e.mu.RUnlock()
	for _, h := range hs {
		h(s)
	}
}

func (e *emitter) listenerCount() int {
	e.mu.RLock()
	defer e.mu.RUnlock()
	return len(e.partials) + len(e.alives) + len(e.statuses)
}

// EventsRegistry is the per-process pub/sub for events the chat UI
// cares about but that don't live in the .jsonl tail. The TS module
// stashes a singleton on globalThis so Next.js dev HMR doesn't drop
// subscribers across module reloads — Go has no HMR analogue, so a
// plain package-level singleton is fine.
type EventsRegistry struct {
	mu       sync.Mutex
	emitters map[string]*emitter
	alive    map[string]bool
	// evictTimers tracks per-session deferred-eviction timers. Once a
	// child has exited, the emitter and the alive flag are no longer
	// load-bearing — but a tail SSE connection may still be subscribed
	// for a few seconds while the UI shows the final state. Defer
	// eviction so subscribers can drain, then drop the entries to keep
	// the global maps bounded over a long-lived bridge.
	evictTimers map[string]*time.Timer
	evictDelay  time.Duration
}

// NewEventsRegistry returns a fresh registry. The package exposes a
// process-global one (Events) so the TS code's globalThis-stashed
// behavior carries over; callers in tests can construct their own
// for isolation.
func NewEventsRegistry() *EventsRegistry {
	return &EventsRegistry{
		emitters:    make(map[string]*emitter),
		alive:       make(map[string]bool),
		evictTimers: make(map[string]*time.Timer),
		evictDelay:  60 * time.Second,
	}
}

// Events is the package-global registry. Mirrors the
// `__bridgeSessionEvents` globalThis stash from the TS module. Tests
// that need isolation construct a private *EventsRegistry instead.
var Events = NewEventsRegistry()

func (r *EventsRegistry) getOrCreate(sessionID string) *emitter {
	r.mu.Lock()
	defer r.mu.Unlock()
	e, ok := r.emitters[sessionID]
	if !ok {
		e = &emitter{}
		r.emitters[sessionID] = e
	}
	return e
}

// EmitPartial publishes one assistant-text delta.
func (r *EventsRegistry) EmitPartial(sessionID string, p PartialEvent) {
	r.getOrCreate(sessionID).emitPartial(p)
}

// EmitAlive flips the alive flag and notifies subscribers. When alive
// is false, schedules eviction of the per-session emitter after the
// configured delay so a late-attaching SSE connection can still drain
// the final state.
func (r *EventsRegistry) EmitAlive(sessionID string, alive bool) {
	r.mu.Lock()
	r.alive[sessionID] = alive
	e, ok := r.emitters[sessionID]
	if !ok {
		e = &emitter{}
		r.emitters[sessionID] = e
	}
	r.mu.Unlock()
	e.emitAlive(alive)
	if !alive {
		r.scheduleEvict(sessionID)
	}
}

// EmitStatus publishes one activity indicator update.
func (r *EventsRegistry) EmitStatus(sessionID string, s StatusEvent) {
	r.getOrCreate(sessionID).emitStatus(s)
}

// IsAlive returns whether a child claude is currently registered
// against this session.
func (r *EventsRegistry) IsAlive(sessionID string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.alive[sessionID]
}

// Subscribe attaches the given handlers to the per-session emitter and
// returns a closer that detaches them. Mirrors the TS subscribeSession
// contract: nil handlers are skipped, the closer is idempotent.
func (r *EventsRegistry) Subscribe(sessionID string, h SubscriptionHandlers) (cancel func()) {
	e := r.getOrCreate(sessionID)
	e.mu.Lock()
	if h.OnPartial != nil {
		e.partials = append(e.partials, h.OnPartial)
	}
	if h.OnAlive != nil {
		e.alives = append(e.alives, h.OnAlive)
	}
	if h.OnStatus != nil {
		e.statuses = append(e.statuses, h.OnStatus)
	}
	e.mu.Unlock()
	var once sync.Once
	return func() {
		once.Do(func() {
			e.mu.Lock()
			defer e.mu.Unlock()
			if h.OnPartial != nil {
				e.partials = removeHandler(e.partials, h.OnPartial)
			}
			if h.OnAlive != nil {
				e.alives = removeAlive(e.alives, h.OnAlive)
			}
			if h.OnStatus != nil {
				e.statuses = removeStatus(e.statuses, h.OnStatus)
			}
		})
	}
}

// scheduleEvict defers per-session cleanup. If a late subscriber
// re-attaches during the delay (e.g. user reopened the tab), reschedule
// rather than evict.
func (r *EventsRegistry) scheduleEvict(sessionID string) {
	r.mu.Lock()
	if t, ok := r.evictTimers[sessionID]; ok {
		t.Stop()
	}
	delay := r.evictDelay
	r.mu.Unlock()
	t := time.AfterFunc(delay, func() {
		r.mu.Lock()
		delete(r.evictTimers, sessionID)
		e, ok := r.emitters[sessionID]
		r.mu.Unlock()
		if ok && e.listenerCount() > 0 {
			r.scheduleEvict(sessionID)
			return
		}
		r.mu.Lock()
		delete(r.emitters, sessionID)
		delete(r.alive, sessionID)
		r.mu.Unlock()
	})
	r.mu.Lock()
	r.evictTimers[sessionID] = t
	r.mu.Unlock()
}

// removeHandler / removeAlive / removeStatus delete the FIRST occurrence
// of fn from the slice (matching by Go's function pointer identity).
// Returns the same slice with the entry removed; len reduced by one.
//
// Function values aren't comparable with == in general, but reflect's
// pointer-comparison via reflect.ValueOf().Pointer() is, and that's
// what we want: the closure wrapping the handler the caller passed in
// is the same object on both Subscribe and the returned cancel(),
// so the pointer matches.
func removeHandler(hs []PartialHandler, target PartialHandler) []PartialHandler {
	for i := range hs {
		if sameFunc(hs[i], target) {
			return append(hs[:i], hs[i+1:]...)
		}
	}
	return hs
}

func removeAlive(hs []AliveHandler, target AliveHandler) []AliveHandler {
	for i := range hs {
		if sameFunc(hs[i], target) {
			return append(hs[:i], hs[i+1:]...)
		}
	}
	return hs
}

func removeStatus(hs []StatusHandler, target StatusHandler) []StatusHandler {
	for i := range hs {
		if sameFunc(hs[i], target) {
			return append(hs[:i], hs[i+1:]...)
		}
	}
	return hs
}

// sameFunc reports whether two function values point at the same
// underlying code. Uses reflect under the hood — function values are
// not directly comparable with ==.
func sameFunc(a, b any) bool {
	// Fast path: nil sentinels.
	if a == nil || b == nil {
		return a == nil && b == nil
	}
	return reflectFuncPointer(a) == reflectFuncPointer(b)
}
