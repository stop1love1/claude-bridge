package detect

// Standardized contract for "given a task body, decide which repo(s) to
// touch and what features / files / entities are in scope". One type
// shape across heuristic + cache + render layers — Go port of
// libs/detect/types.ts.
//
// The TS module shipped a heuristic + LLM detector pair plus an `auto`
// mode that tried LLM and fell back to heuristic. The S16 follow-up Go
// cut intentionally collapses that to heuristic-only — the LLM client
// wiring lands later. Keeping the public types verbatim means the LLM
// port can drop in without breaking callers.

import (
	"encoding/json"
	"time"

	"github.com/stop1love1/claude-bridge/internal/apps"
)

// Source identifies which detector impl produced a DetectedScope. The
// `user-pinned` value is set when the operator explicitly picked a repo
// via the NewSessionDialog — detector still ran for features / entities
// / files, but `repos[0]` is the user's pick.
type Source string

const (
	// SourceHeuristic — pure-local detector. The only impl shipped today.
	SourceHeuristic Source = "heuristic"
	// SourceLLM — LLM-backed detector. Reserved for the follow-up port.
	SourceLLM Source = "llm"
	// SourceUserPinned — operator override; see Source comment.
	SourceUserPinned Source = "user-pinned"
)

// Confidence is a coarse signal the coordinator weighs alongside the
// task body itself. Values match the TS string union exactly.
type Confidence string

const (
	// ConfidenceHigh — LLM call succeeded with a clear winner. Heuristic
	// only ever returns this when the user pinned a repo.
	ConfidenceHigh Confidence = "high"
	// ConfidenceMedium — heuristic top-1 with a margin over runner-up.
	ConfidenceMedium Confidence = "medium"
	// ConfidenceLow — heuristic with no clear winner OR LLM fallback.
	// The coordinator should weigh the task body before trusting
	// repos[0].
	ConfidenceLow Confidence = "low"
)

// Mode is the global detection mode. The TS layer persisted this at
// `bridge.json.detect.source`; the Go side defers reading that field
// until the LLM impl lands. For now Detector.Detect always runs the
// heuristic regardless of Mode.
type Mode string

const (
	// ModeAuto — try LLM, fall back to heuristic on error / disabled.
	ModeAuto Mode = "auto"
	// ModeLLM — LLM only; on error, return heuristic with low confidence.
	ModeLLM Mode = "llm"
	// ModeHeuristic — never call LLM; pure local detection.
	ModeHeuristic Mode = "heuristic"
)

// RepoMatch is one candidate repo with its score + the reason it
// scored that high. Scores aren't comparable across detector impls —
// only compare within one DetectedScope.
type RepoMatch struct {
	Name string `json:"name"`
	// Higher = better match.
	Score int `json:"score"`
	// Human-readable reason — surfaced in the coordinator prompt.
	Reason string `json:"reason"`
}

// Feature is a high-level capability label like "auth.login" /
// "lms.course". Stored as a string alias so the render layer can
// accept either declared capabilities (operator-curated) or the
// heuristic's built-in vocab uniformly.
type Feature = string

// Entity is a domain noun extracted from the task body — "course",
// "lesson", "student". Bilingual: the heuristic resolves the
// Vietnamese form ("hoc vien") to its canonical English label.
type Entity = string

// FileOfInterest is a path or glob the task body explicitly named.
// Bare strings rather than a struct because that's the on-disk shape
// the TS module persisted; tightening the type later would break
// meta.json round-trips.
type FileOfInterest = string

// DetectedScope is the single output shape every detector impl must
// return. Persisted to meta.json and rendered into prompts — additive
// changes only, never remove or rename fields once shipped.
type DetectedScope struct {
	// Repos is sorted by score descending. Repos[0] is the dispatch target.
	Repos []RepoMatch `json:"repos"`
	// Features intersected against the union of declared
	// `app.capabilities` from bridge.json. Lowercased, deduped. Empty
	// = no clear feature signal.
	Features []Feature `json:"features"`
	// Entities — domain nouns mentioned in the task body. Bilingual:
	// the heuristic collapses Vietnamese forms to canonical English.
	Entities []Entity `json:"entities"`
	// Files — specific paths or globs the task body explicitly
	// references. Empty when the task is feature-shaped rather than
	// file-shaped.
	Files []FileOfInterest `json:"files"`
	// Confidence — see the Confidence type's comment.
	Confidence Confidence `json:"confidence"`
	// Source — see the Source type's comment.
	Source Source `json:"source"`
	// DetectedAt is RFC3339Nano so it round-trips with the TS
	// `new Date().toISOString()` shape.
	DetectedAt string `json:"detectedAt"`
	// Reason — one-line summary for logs / UI tooltips. Detector-
	// specific phrasing.
	Reason string `json:"reason"`
}

// DetectInput is handed to every detector impl. Only TaskBody and
// Repos are mandatory — the rest are optional signals that boost
// scoring quality when present.
type DetectInput struct {
	// TaskBody — primary signal. Must be the user's verbatim text.
	TaskBody string
	// TaskTitle — secondary signal. Often more concise than the body
	// and useful when the body is verbose / multi-paragraph.
	TaskTitle string
	// Repos — allowlist of repo names. Only these can win.
	Repos []string
	// Profiles — cached repo profiles. Required for any impl to score
	// above zero — without profile data there's no signal beyond the
	// declared capabilities.
	Profiles map[string]apps.RepoProfile
	// Capabilities — per-app declared capabilities from
	// bridge.json.apps[].capabilities. Free-form tags like
	// ["lms.course", "auth.login"]. Operator-curated, highest weight.
	Capabilities map[string][]string
	// PinnedRepo — repo the user pinned via the NewSessionDialog. When
	// non-empty, detector still runs but Source is SourceUserPinned and
	// Repos[0].Name == PinnedRepo (caller-provided pin always wins).
	PinnedRepo string
}

// CacheEntry is the on-disk shape persisted under
// meta.detectedScope. The hash lets us spot when the cached scope was
// computed against an outdated task body — cache.go treats a hash
// mismatch as "no cache" so the detect path falls back to live
// detection.
type CacheEntry struct {
	TaskBodyHash string        `json:"taskBodyHash"`
	Scope        DetectedScope `json:"scope"`
}

// EmptyScope returns the placeholder a detector must use when there's
// genuinely no signal. Keeping the construction helper public so the
// LLM impl reuses the exact same shape — drift between the two impls'
// "no signal" outputs would surface as confusing prompt churn.
func EmptyScope(reason string) DetectedScope {
	return DetectedScope{
		Repos:      []RepoMatch{},
		Features:   []Feature{},
		Entities:   []Entity{},
		Files:      []FileOfInterest{},
		Confidence: ConfidenceLow,
		Source:     SourceHeuristic,
		DetectedAt: time.Now().UTC().Format(time.RFC3339Nano),
		Reason:     reason,
	}
}

// MarshalCacheEntry encodes a CacheEntry to bytes suitable for the
// meta.json `detectedScope` field. Wraps json.Marshal only so the
// failure shape is consistent across the package.
func MarshalCacheEntry(entry CacheEntry) (json.RawMessage, error) {
	return json.Marshal(entry)
}

// UnmarshalCacheEntry decodes the meta.json `detectedScope` field. A
// nil / empty input is treated as "no cache" — readers don't have to
// branch on the missing-field case before calling.
func UnmarshalCacheEntry(raw json.RawMessage) (*CacheEntry, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	var entry CacheEntry
	if err := json.Unmarshal(raw, &entry); err != nil {
		return nil, err
	}
	return &entry, nil
}
