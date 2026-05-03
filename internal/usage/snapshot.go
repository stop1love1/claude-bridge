// Package usage aggregates token + cost usage stats from session
// JSONL events, both per-task and across the whole bridge, for the
// /api/usage and /api/tasks/<id>/usage endpoints.
//
// Ported from libs/sessionUsage.ts + libs/usageStats.ts in S06. The
// quota panel from Anthropic's `/api/oauth/usage` endpoint is stubbed
// in this iteration (returns Quota.Error="not implemented") — full
// OAuth fetch + retry-after handling lands when the auth/credentials
// wiring is plumbed (S13/S14).
package usage

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// Reader wraps the file paths used to compute a usage snapshot. Tests
// override Root to point at a fixture; production callers use New().
type Reader struct {
	// Root is the absolute path to ~/.claude (or its fixture-equivalent).
	// stats-cache.json and .credentials.json are resolved relative to it.
	Root string
	// Now is overridable for deterministic tests; defaults to time.Now.
	Now func() time.Time
	// QuotaFetcher is the hook for the upstream Anthropic quota call.
	// Defaults to NotImplementedQuota — full OAuth fetch lands when
	// auth/credentials wiring ports (S13/S14). Tests override with a
	// fake to assert wire-up without external HTTP.
	QuotaFetcher QuotaFetcher

	mu    sync.Mutex
	cache *cachedSnapshot
}

type cachedSnapshot struct {
	value   Snapshot
	expires time.Time
}

// QuotaFetcher abstracts the upstream Anthropic quota fetch so the
// snapshot reader stays testable. Implementations may consult the raw
// credentials map (decoded from .credentials.json) to extract the
// OAuth bearer; the stub doesn't.
type QuotaFetcher interface {
	Fetch(cred *RawCredentials, now time.Time) Quota
}

// NotImplementedQuota is the default fetcher — returns an empty Quota
// with Error="not implemented (S13/S14)" so the UI degrades gracefully
// to the local stats panel.
type NotImplementedQuota struct{}

// Fetch returns the empty-quota stub. The UI surfaces Error in place
// of empty bars, matching how Next handles unreachable Anthropic.
func (NotImplementedQuota) Fetch(_ *RawCredentials, now time.Time) Quota {
	return emptyQuota("not implemented (S13/S14)", now.UTC().Format(time.RFC3339Nano))
}

// New returns a Reader pointing at ~/.claude with the stub quota
// fetcher. Tests typically construct &Reader{Root: tempDir,
// QuotaFetcher: fake} directly.
func New() *Reader {
	home, err := os.UserHomeDir()
	root := filepath.Join(home, ".claude")
	if err != nil {
		root = ".claude"
	}
	return &Reader{Root: root, Now: time.Now, QuotaFetcher: NotImplementedQuota{}}
}

// ttl values mirror libs/usageStats.ts:
//   - success     → 60 s so polling doesn't burn rate-limit budget
//   - other error → 8  s so a transient blip doesn't pin the UI to
//     "unavailable" for a full minute
const (
	ttlOK  = 60 * time.Second
	ttlErr = 8 * time.Second
)

// ModelUsage matches the shape Claude writes into stats-cache.json.
// Field tags use lowerCamelCase to mirror Next's JSON.
type ModelUsage struct {
	InputTokens              int64   `json:"inputTokens"`
	OutputTokens             int64   `json:"outputTokens"`
	CacheReadInputTokens     int64   `json:"cacheReadInputTokens"`
	CacheCreationInputTokens int64   `json:"cacheCreationInputTokens"`
	WebSearchRequests        int64   `json:"webSearchRequests"`
	CostUSD                  float64 `json:"costUSD"`
	ContextWindow            int64   `json:"contextWindow"`
	MaxOutputTokens          int64   `json:"maxOutputTokens"`
}

// DailyActivity is one row of the daily-activity bar chart.
type DailyActivity struct {
	Date          string `json:"date"`
	MessageCount  int64  `json:"messageCount"`
	SessionCount  int64  `json:"sessionCount"`
	ToolCallCount int64  `json:"toolCallCount"`
}

// DailyModelTokens is one row of the daily-by-model stacked chart.
type DailyModelTokens struct {
	Date          string           `json:"date"`
	TokensByModel map[string]int64 `json:"tokensByModel"`
}

// LongestSession is the standout row in the "highlights" panel.
type LongestSession struct {
	SessionID    string `json:"sessionId"`
	Duration     int64  `json:"duration"`
	MessageCount int64  `json:"messageCount"`
	Timestamp    string `json:"timestamp"`
}

// QuotaWindow is one of the bar charts in the quota panel.
type QuotaWindow struct {
	Utilization float64 `json:"utilization"`
	ResetsAt    *string `json:"resetsAt"`
}

// ExtraUsage represents the "Extra usage" line item.
type ExtraUsage struct {
	IsEnabled    bool     `json:"isEnabled"`
	MonthlyLimit *float64 `json:"monthlyLimit"`
	UsedCredits  *float64 `json:"usedCredits"`
	Utilization  *float64 `json:"utilization"`
	Currency     *string  `json:"currency"`
}

// Quota is the live-quota panel grouped to mirror the screenshot.
// All window pointers are nil when the source field was absent / null
// in the upstream response.
type Quota struct {
	FiveHour           *QuotaWindow `json:"fiveHour"`
	WeeklyAllModels    *QuotaWindow `json:"weeklyAllModels"`
	WeeklySonnet       *QuotaWindow `json:"weeklySonnet"`
	WeeklyOpus         *QuotaWindow `json:"weeklyOpus"`
	WeeklyClaudeDesign *QuotaWindow `json:"weeklyClaudeDesign"`
	WeeklyOauthApps    *QuotaWindow `json:"weeklyOauthApps"`
	WeeklyCowork       *QuotaWindow `json:"weeklyCowork"`
	ExtraUsage         *ExtraUsage  `json:"extraUsage"`
	// Error is non-nil when fetch failed; UI surfaces it instead of
	// empty bars.
	Error     *string `json:"error"`
	FetchedAt string  `json:"fetchedAt"`
}

// Plan is the header chip showing subscription tier.
type Plan struct {
	SubscriptionType string `json:"subscriptionType"`
	RateLimitTier    string `json:"rateLimitTier"`
}

// Snapshot is the complete /api/usage response shape. Mirrors the
// Next UsageSnapshot interface bytewise.
type Snapshot struct {
	Source           string                `json:"source"`
	CacheUpdatedAt   *string               `json:"cacheUpdatedAt"`
	LastComputedDate *string               `json:"lastComputedDate"`
	TotalSessions    int64                 `json:"totalSessions"`
	TotalMessages    int64                 `json:"totalMessages"`
	FirstSessionDate *string               `json:"firstSessionDate"`
	ModelUsage       map[string]ModelUsage `json:"modelUsage"`
	DailyActivity    []DailyActivity       `json:"dailyActivity"`
	DailyModelTokens []DailyModelTokens    `json:"dailyModelTokens"`
	LongestSession   *LongestSession       `json:"longestSession"`
	HourCounts       map[string]int64      `json:"hourCounts"`
	Plan             *Plan                 `json:"plan"`
	Quota            *Quota                `json:"quota"`
}

// RawCredentials is the subset of ~/.claude/.credentials.json the
// snapshot reader cares about. Carries the OAuth tokens — callers
// MUST NOT echo anything from ClaudeAiOauth back to the client beyond
// what readPlan extracts.
type RawCredentials struct {
	ClaudeAiOauth *struct {
		AccessToken      string `json:"accessToken"`
		ExpiresAt        int64  `json:"expiresAt"`
		SubscriptionType string `json:"subscriptionType"`
		RateLimitTier    string `json:"rateLimitTier"`
	} `json:"claudeAiOauth"`
}

// Read returns the cached snapshot, refreshing if stale or force is
// true. The cache TTL mirrors the TS impl: 60s on success, 8s on
// quota error. Concurrent calls during a refresh share the result —
// the mutex serializes both lookup and refresh so we don't fan out
// duplicate Anthropic requests.
func (r *Reader) Read(force bool) Snapshot {
	r.mu.Lock()
	defer r.mu.Unlock()
	now := r.now()
	if !force && r.cache != nil && r.cache.expires.After(now) {
		return r.cache.value
	}

	statsPath := filepath.Join(r.Root, "stats-cache.json")
	credPath := filepath.Join(r.Root, ".credentials.json")

	var cacheUpdatedAt *string
	if st, err := os.Stat(statsPath); err == nil {
		s := st.ModTime().UTC().Format(time.RFC3339Nano)
		cacheUpdatedAt = &s
	}

	raw, _ := readJSONFile(statsPath)
	cred, _ := readCredentials(credPath)
	plan := readPlan(cred)

	quota := r.quotaFetcher().Fetch(cred, now)

	value := buildSnapshot(raw, cacheUpdatedAt, plan, &quota)

	ttl := ttlOK
	if quota.Error != nil {
		ttl = ttlErr
	}
	r.cache = &cachedSnapshot{value: value, expires: now.Add(ttl)}
	return value
}

func (r *Reader) now() time.Time {
	if r.Now != nil {
		return r.Now()
	}
	return time.Now()
}

func (r *Reader) quotaFetcher() QuotaFetcher {
	if r.QuotaFetcher != nil {
		return r.QuotaFetcher
	}
	return NotImplementedQuota{}
}

// rawStatsCache is the on-disk shape of stats-cache.json. Every field
// is optional — claude may write a partial file when the run is short.
type rawStatsCache struct {
	LastComputedDate *string               `json:"lastComputedDate"`
	DailyActivity    []DailyActivity       `json:"dailyActivity"`
	DailyModelTokens []DailyModelTokens    `json:"dailyModelTokens"`
	ModelUsage       map[string]ModelUsage `json:"modelUsage"`
	TotalSessions    *int64                `json:"totalSessions"`
	TotalMessages    *int64                `json:"totalMessages"`
	LongestSession   *LongestSession       `json:"longestSession"`
	FirstSessionDate *string               `json:"firstSessionDate"`
	HourCounts       map[string]int64      `json:"hourCounts"`
}

func readJSONFile(path string) (*rawStatsCache, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var v rawStatsCache
	if err := json.Unmarshal(b, &v); err != nil {
		return nil, err
	}
	return &v, nil
}

func readCredentials(path string) (*RawCredentials, error) {
	b, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var v RawCredentials
	if err := json.Unmarshal(b, &v); err != nil {
		return nil, err
	}
	return &v, nil
}

// readPlan extracts only the safe-to-echo fields. The OAuth tokens MUST
// stay server-side.
func readPlan(cred *RawCredentials) *Plan {
	if cred == nil || cred.ClaudeAiOauth == nil || cred.ClaudeAiOauth.SubscriptionType == "" {
		return nil
	}
	return &Plan{
		SubscriptionType: cred.ClaudeAiOauth.SubscriptionType,
		RateLimitTier:    cred.ClaudeAiOauth.RateLimitTier,
	}
}

// buildSnapshot fills the Snapshot envelope. When raw is nil the
// snapshot is the "missing source" shape — mirrors the TS ternary.
func buildSnapshot(raw *rawStatsCache, cacheUpdatedAt *string, plan *Plan, quota *Quota) Snapshot {
	out := Snapshot{
		Source:           "missing",
		CacheUpdatedAt:   cacheUpdatedAt,
		LastComputedDate: nil,
		TotalSessions:    0,
		TotalMessages:    0,
		FirstSessionDate: nil,
		ModelUsage:       map[string]ModelUsage{},
		DailyActivity:    []DailyActivity{},
		DailyModelTokens: []DailyModelTokens{},
		LongestSession:   nil,
		HourCounts:       map[string]int64{},
		Plan:             plan,
		Quota:            quota,
	}
	if raw == nil {
		// "missing" source keeps cacheUpdatedAt nil per TS.
		out.CacheUpdatedAt = nil
		return out
	}
	out.Source = "stats-cache"
	out.LastComputedDate = raw.LastComputedDate
	if raw.TotalSessions != nil {
		out.TotalSessions = *raw.TotalSessions
	}
	if raw.TotalMessages != nil {
		out.TotalMessages = *raw.TotalMessages
	}
	out.FirstSessionDate = raw.FirstSessionDate
	if raw.ModelUsage != nil {
		out.ModelUsage = raw.ModelUsage
	}
	if raw.DailyActivity != nil {
		out.DailyActivity = raw.DailyActivity
	}
	if raw.DailyModelTokens != nil {
		out.DailyModelTokens = raw.DailyModelTokens
	}
	out.LongestSession = raw.LongestSession
	if raw.HourCounts != nil {
		out.HourCounts = raw.HourCounts
	}
	return out
}

// emptyQuota produces the no-data quota panel with the given error.
// Mirrors EMPTY_QUOTA from the TS module.
func emptyQuota(reason, fetchedAt string) Quota {
	r := reason
	return Quota{
		FiveHour:           nil,
		WeeklyAllModels:    nil,
		WeeklySonnet:       nil,
		WeeklyOpus:         nil,
		WeeklyClaudeDesign: nil,
		WeeklyOauthApps:    nil,
		WeeklyCowork:       nil,
		ExtraUsage:         nil,
		Error:              &r,
		FetchedAt:          fetchedAt,
	}
}
