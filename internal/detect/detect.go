package detect

// Top-level orchestration for the detect layer. Go port of
// libs/detect/index.ts, with the LLM upgrade path collapsed to
// heuristic-only — see the package doc.go for why.
//
// Caller-facing surface mirrors the TS module:
//   - LoadInput(opts)               — build a DetectInput from caller-
//                                     supplied app + capability data.
//   - GetOrCompute(dir, build, ...) — read cache, fall back to detect
//                                     + persist on miss.
//   - Refresh(dir, build, ...)      — clear cache, re-detect, persist.
//   - WriteScope                    — re-exported from cache.go for
//                                     the few callers that detect
//                                     out-of-band and want to attach
//                                     the result themselves.
//
// The Detector struct is a thin shim that exists so the eventual LLM
// port can supply an alternative impl without changing callers — the
// production code path goes through Default(), which today returns a
// heuristic-only detector.

import (
	"encoding/json"

	"github.com/stop1love1/claude-bridge/internal/apps"
)

// InputOptions are the caller-provided fields LoadInput collapses
// into a DetectInput. AppList + Capabilities + Profiles must be passed
// in by the caller because the bridge.json reader and the
// repo-profile cache live in the apps package — keeping the detect
// package free of those imports avoids a future apps↔detect import
// cycle once the apps package needs to render scopes.
type InputOptions struct {
	TaskBody     string
	TaskTitle    string
	PinnedRepo   string
	AppList      []apps.App
	Profiles     map[string]apps.RepoProfile
	Capabilities map[string][]string

	// RepoOverride lets the caller bypass the apps roster and supply
	// its own allowlist of repo names (used by tests + by the future
	// per-task "scope to these repos only" UI). Empty -> use AppList.
	RepoOverride []string
}

// LoadInput collapses an InputOptions into a DetectInput. The single
// place all the wiring lives, so callers (createTask, refresh route,
// agents route) don't have to each replicate the lookup.
func LoadInput(opts InputOptions) DetectInput {
	repos := opts.RepoOverride
	if len(repos) == 0 {
		repos = make([]string, 0, len(opts.AppList))
		for _, a := range opts.AppList {
			repos = append(repos, a.Name)
		}
	}

	caps := opts.Capabilities
	if caps == nil && len(opts.AppList) > 0 {
		// Build the per-app capabilities map straight from the App
		// list when the caller didn't pre-compute one. Apps without
		// declared capabilities simply don't appear.
		built := map[string][]string{}
		for _, a := range opts.AppList {
			declared := capabilitiesFromApp(a)
			if len(declared) > 0 {
				built[a.Name] = declared
			}
		}
		if len(built) > 0 {
			caps = built
		}
	}

	return DetectInput{
		TaskBody:     opts.TaskBody,
		TaskTitle:    opts.TaskTitle,
		Repos:        repos,
		Profiles:     opts.Profiles,
		Capabilities: caps,
		PinnedRepo:   opts.PinnedRepo,
	}
}

// capabilitiesFromApp pulls the optional `capabilities` array out of
// the App's pass-through Extras. The apps package doesn't yet expose
// a typed Capabilities field — Extras carries the JSON verbatim until
// the verify-chain port wires them in. Decoding here keeps the
// detect package from forcing an apps API change.
func capabilitiesFromApp(a apps.App) []string {
	raw, ok := a.Extras["capabilities"]
	if !ok || len(raw) == 0 {
		return nil
	}
	var out []string
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil
	}
	return out
}

// Detector is the impl-swappable detector. Today there's only the
// heuristic; the LLM upgrade path will plug in a different Impl
// without changing call sites.
type Detector struct {
	// Impl is the actual detection function. Defaults to the
	// heuristic when nil — pre-empting nil checks at every call site.
	Impl func(input DetectInput) DetectedScope
}

// Default returns a detector wired to the heuristic. Callers in
// production code use this; tests construct their own with a fake
// Impl when they need to assert on dispatch shape rather than
// scoring behavior.
func Default() *Detector {
	return &Detector{Impl: Detect}
}

// Run runs the detector. Always resolves — never panics, never
// errors. The TS port returned a Promise<DetectedScope>; the Go
// equivalent is sync because there's no LLM I/O on this code path.
func (d *Detector) Run(input DetectInput) DetectedScope {
	if d == nil || d.Impl == nil {
		return Detect(input)
	}
	return d.Impl(input)
}

// GetOrCompute reads the cached scope for a task; if the cache is
// stale or absent, computes a fresh scope using the live input AND
// persists it. Used by the coordinator + agents path so the same
// scope is read across many spawns without re-running detection.
//
// inputBuilder is called only on cache miss — the caller doesn't pay
// for the apps registry walk on a hit.
func (d *Detector) GetOrCompute(sessionsDir string, inputBuilder func() DetectInput) (DetectedScope, error) {
	if cached, err := ReadScopeCache(sessionsDir); err == nil && cached != nil {
		return *cached, nil
	}
	input := inputBuilder()
	scope := d.Run(input)
	// Best-effort persist — a write failure shouldn't block the
	// dispatch. The error is returned alongside the scope so
	// callers can log it without forcing them to handle it.
	if err := WriteScopeCache(sessionsDir, scope); err != nil {
		return scope, err
	}
	return scope, nil
}

// Refresh drops the cached scope and re-runs detection. Used by
// "POST /api/tasks/<id>/detect/refresh".
func (d *Detector) Refresh(sessionsDir string, inputBuilder func() DetectInput) (DetectedScope, error) {
	if err := ClearScopeCache(sessionsDir); err != nil {
		return DetectedScope{}, err
	}
	input := inputBuilder()
	scope := d.Run(input)
	if err := WriteScopeCache(sessionsDir, scope); err != nil {
		return scope, err
	}
	return scope, nil
}

// WriteScope is the package-level convenience for the rare caller
// (e.g. CLI tooling that ran detect out-of-band) that wants to
// attach a precomputed scope. Equivalent to calling WriteScopeCache.
func WriteScope(sessionsDir string, scope DetectedScope) error {
	return WriteScopeCache(sessionsDir, scope)
}
