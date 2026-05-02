package spawn

import "sync"

// InFlightGate is a per-key lock that returns "already running" instead
// of blocking. Wraps a set of keys whose value is "an op of this kind
// is currently running". Used by routes that spawn coordinators / fire
// long-running side effects to dedup button-mash ("continue", "clear",
// "spawn") so the user doesn't end up with two coordinators for the
// same task.
//
// Granularity is per (kind, key). Two different routes (`continue`,
// `clear`) on the same task each get their own gate, but two
// concurrent POSTs to the same route on the same task share one.
//
// Ported from libs/inFlight.ts. The TS module stashed a single Map
// on globalThis to survive HMR; Go uses one *InFlightGate per kind
// (constructed where the route lives), and a process-global registry
// is built in Gates below for callers that want the TS shape.
type InFlightGate struct {
	mu   sync.Mutex
	keys map[string]struct{}
}

// NewGate returns an empty per-key gate.
func NewGate() *InFlightGate {
	return &InFlightGate{keys: make(map[string]struct{})}
}

// Acquire claims the key. Returns true on success (key was free, now
// held by the caller), false when another caller already holds it. The
// caller MUST call Release once when done — typically via defer right
// after the success branch.
func (g *InFlightGate) Acquire(key string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	if _, busy := g.keys[key]; busy {
		return false
	}
	g.keys[key] = struct{}{}
	return true
}

// Release drops the claim. Idempotent — releasing a key that's not
// held is a no-op (covers double-release after a panic recovery).
func (g *InFlightGate) Release(key string) {
	g.mu.Lock()
	defer g.mu.Unlock()
	delete(g.keys, key)
}

// IsBusy peeks whether the key is currently held. Cheap, lock-free
// from the caller's perspective. Used by tests + the API health
// endpoint to surface in-flight counts without acquiring.
func (g *InFlightGate) IsBusy(key string) bool {
	g.mu.Lock()
	defer g.mu.Unlock()
	_, busy := g.keys[key]
	return busy
}

// WithInFlight runs fn while key is locked under the gate. If another
// caller is already inside the same key, returns (zero T, false) —
// caller responds with 409 / no-op rather than starting a duplicate
// operation. The gate is released on fn return (success or panic) so
// a crashing op can't strand the gate.
//
// Generic over T because the bridge's callers vary in their return
// type (HTTP handlers return responses; cron jobs return errors).
func WithInFlight[T any](g *InFlightGate, key string, fn func() T) (T, bool) {
	var zero T
	if !g.Acquire(key) {
		return zero, false
	}
	defer g.Release(key)
	return fn(), true
}

// Gates is a process-global map of per-kind gates, mirroring the TS
// module's globalThis stash. Callers that don't want to plumb a
// *InFlightGate through their layer use this — typically routes that
// only need one (kind, key) pair.
var Gates = newGateRegistry()

type gateRegistry struct {
	mu    sync.Mutex
	gates map[string]*InFlightGate
}

func newGateRegistry() *gateRegistry {
	return &gateRegistry{gates: make(map[string]*InFlightGate)}
}

// For returns the gate for the named kind, creating one on first
// reference. Stable handle — repeated calls with the same kind return
// the same *InFlightGate so two routes sharing a kind share state.
func (r *gateRegistry) For(kind string) *InFlightGate {
	r.mu.Lock()
	defer r.mu.Unlock()
	g, ok := r.gates[kind]
	if !ok {
		g = NewGate()
		r.gates[kind] = g
	}
	return g
}
